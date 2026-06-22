#!/usr/bin/env bash
# Step 0 bootstrap (GCP). Run ONCE, locally, by a human with admin on the target
# project (Owner, or the granular admin roles below) and the rights to create a
# Workload Identity pool.
#
# Assumes the project already exists and has billing linked. To create one as part
# of the pattern, run ./create-project.sh (step -1) first - it prints the PROJECT_ID
# to pass here.
#
# It solves the two chicken-and-egg problems that block CI-driven OpenTofu:
#   1. Remote state has nowhere to live yet  -> create the tfstate backend
#      (a versioned GCS bucket). This script uses gcloud/gsutil, not tofu, so it
#      needs no pre-existing remote state itself.
#   2. CI has no identity yet               -> create the Workload Identity
#      Federation pool + provider and a service account so GitHub Actions can run
#      `tofu` over OIDC with no stored secret (the Entra-app + federated-credential
#      analogue; see ../azure/bootstrap.sh).
#
# Everything is parameterised (env vars below); nothing hardcodes a project, region
# or org. Re-running is safe: every step checks before it creates.
#
# Usage:
#   PROJECT_ID=... ./bootstrap.sh
# Optional overrides:
#   REGION=europe-west2 WORKLOAD=wl STATE_BUCKET=wl-tfstate-<token> ./bootstrap.sh
# Required: REPO=<github-org>/wavelength (your private fork's slug; the WIF binding
#   must match it exactly, so there is no default).

set -euo pipefail

# --- Parameters ---------------------------------------------------------------
PROJECT_ID="${PROJECT_ID:?Set PROJECT_ID to the target GCP project}"
REGION="${REGION:-europe-west2}"
WORKLOAD="${WORKLOAD:-wl}"
REPO="${REPO:?Set REPO=<github-org>/wavelength to your private fork's slug (the WIF subject claim must match it)}"

# Instance token: a deterministic hash of project + workload (the analogue of
# Azure's uniqueString). The landing zone derives the identical value via tofu's
# sha1(), so every globally-unique name shares one token with nothing passed between.
INSTANCE_ID="$(printf '%s' "${PROJECT_ID}-${WORKLOAD}" | sha1sum | cut -c1-8)"

# State backend. GCS bucket names are global (3-63 lower alnum + hyphens), so the
# bucket carries the token. The state prefix matches iac/gcp/backend.tf.
STATE_BUCKET="${STATE_BUCKET:-${WORKLOAD}-tfstate-${INSTANCE_ID}}"
STATE_PREFIX="gcp-landing-zone"

# Service account CI authenticates as (the Entra-app analogue).
SA_NAME="${SA_NAME:-${WORKLOAD}-github-oidc}"
SA_EMAIL="${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"

# Workload Identity Federation names.
WIF_POOL="${WIF_POOL:-github}"
WIF_PROVIDER="${WIF_PROVIDER:-github-actions}"
GH_ISSUER="https://token.actions.githubusercontent.com"

# --- Preflight ----------------------------------------------------------------
command -v gcloud >/dev/null || { echo "ERROR: gcloud not found" >&2; exit 1; }
command -v gsutil >/dev/null || { echo "ERROR: gsutil not found" >&2; exit 1; }
gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . \
  || { echo "ERROR: run 'gcloud auth login' first" >&2; exit 1; }

echo "==> Targeting project ${PROJECT_ID} (region ${REGION})"
gcloud config set project "$PROJECT_ID" >/dev/null

PROJECT_NUMBER="$(gcloud projects describe "$PROJECT_ID" --format='value(projectNumber)')"
CALLER="$(gcloud config get-value account 2>/dev/null)"

# =============================================================================
# 1. Enable APIs. A freshly created project has almost none of what the landing
#    zone needs. This is GCP's analogue of Azure provider registration; the call
#    blocks until each API is enabled, so the subsequent steps and `tofu apply`
#    find them ready.
# =============================================================================
echo "==> [1/4] Enabling APIs"
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  vpcaccess.googleapis.com \
  servicenetworking.googleapis.com \
  compute.googleapis.com \
  cloudbuild.googleapis.com \
  iam.googleapis.com \
  iamcredentials.googleapis.com \
  sts.googleapis.com \
  logging.googleapis.com \
  cloudresourcemanager.googleapis.com \
  orgpolicy.googleapis.com \
  iap.googleapis.com \
  --project="$PROJECT_ID"

# IAP service agent: app LB stacks grant it run.invoker (IAP -> Cloud Run). It is
# created lazily otherwise, so a first app apply fails with "service account ... does
# not exist". Provision it now (idempotent).
gcloud beta services identity create --service=iap.googleapis.com --project="$PROJECT_ID" >/dev/null 2>&1 \
  && echo "    IAP service agent provisioned" || echo "    IAP service agent: already present or beta unavailable"

# =============================================================================
# 2. State backend: a versioned GCS bucket
# =============================================================================
echo "==> [2/4] State backend"
if gsutil ls -b "gs://${STATE_BUCKET}" >/dev/null 2>&1; then
  echo "    bucket gs://${STATE_BUCKET} exists"
else
  echo "    creating bucket gs://${STATE_BUCKET}"
  # Uniform bucket-level access (IAM only, no ACLs) - the no-shared-key analogue.
  gsutil mb -p "$PROJECT_ID" -l "$REGION" -b on "gs://${STATE_BUCKET}"
  # Versioning protects the state object against accidental overwrite/corruption.
  gsutil versioning set on "gs://${STATE_BUCKET}"
  # Block all public access on the bucket.
  gsutil pap set enforced "gs://${STATE_BUCKET}"
fi

# The human running tofu locally needs object access to the state bucket.
echo "    ensuring caller has objectAdmin on the state bucket"
gsutil iam ch "user:${CALLER}:roles/storage.objectAdmin" "gs://${STATE_BUCKET}" >/dev/null 2>&1 || true

# =============================================================================
# 3. CI identity: Workload Identity Federation pool + provider + service account
# =============================================================================
echo "==> [3/4] GitHub OIDC identity"

if gcloud iam service-accounts describe "$SA_EMAIL" --project="$PROJECT_ID" >/dev/null 2>&1; then
  echo "    service account ${SA_NAME} exists"
else
  echo "    creating service account ${SA_NAME}"
  gcloud iam service-accounts create "$SA_NAME" \
    --project="$PROJECT_ID" \
    --display-name="${WORKLOAD} GitHub Actions CI" >/dev/null
fi

if gcloud iam workload-identity-pools describe "$WIF_POOL" \
    --project="$PROJECT_ID" --location=global >/dev/null 2>&1; then
  echo "    workload identity pool ${WIF_POOL} exists"
else
  echo "    creating workload identity pool ${WIF_POOL}"
  gcloud iam workload-identity-pools create "$WIF_POOL" \
    --project="$PROJECT_ID" --location=global \
    --display-name="GitHub Actions" >/dev/null
fi

if gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER" \
    --project="$PROJECT_ID" --location=global \
    --workload-identity-pool="$WIF_POOL" >/dev/null 2>&1; then
  echo "    provider ${WIF_PROVIDER} exists"
else
  echo "    creating OIDC provider ${WIF_PROVIDER} (restricted to repo ${REPO})"
  # attribute-condition restricts the pool to exactly this repo - without it any
  # GitHub repo's token could impersonate the SA.
  gcloud iam workload-identity-pools providers create-oidc "$WIF_PROVIDER" \
    --project="$PROJECT_ID" --location=global \
    --workload-identity-pool="$WIF_POOL" \
    --issuer-uri="$GH_ISSUER" \
    --attribute-mapping="google.subject=assertion.sub,attribute.repository=assertion.repository,attribute.ref=assertion.ref" \
    --attribute-condition="assertion.repository=='${REPO}'" >/dev/null
fi

POOL_NAME="$(gcloud iam workload-identity-pools describe "$WIF_POOL" \
  --project="$PROJECT_ID" --location=global --format='value(name)')"
PROVIDER_NAME="$(gcloud iam workload-identity-pools providers describe "$WIF_PROVIDER" \
  --project="$PROJECT_ID" --location=global --workload-identity-pool="$WIF_POOL" \
  --format='value(name)')"

# Let any GitHub Actions run in this repo impersonate the CI SA (covers both push
# to main and pull_request - the two Azure federated credentials in one binding).
echo "    binding repo:${REPO} -> ${SA_NAME} (workloadIdentityUser)"
gcloud iam service-accounts add-iam-policy-binding "$SA_EMAIL" \
  --project="$PROJECT_ID" \
  --role="roles/iam.workloadIdentityUser" \
  --member="principalSet://iam.googleapis.com/${POOL_NAME}/attribute.repository/${REPO}" >/dev/null

# =============================================================================
# 4. Role bindings (least privilege for what iac/gcp/ + gateway-gcp/ create)
# =============================================================================
# The landing zone creates resources, binds IAM to a runtime SA, and (optionally)
# sets org policy. The project-level roles below cover that; storage.objectAdmin on
# the state bucket lets CI read/write tofu state.
echo "==> [4/4] Role bindings for CI service account"

bind_project_role() {
  local role="$1"
  echo "    ${role}"
  gcloud projects add-iam-policy-binding "$PROJECT_ID" \
    --member="serviceAccount:${SA_EMAIL}" --role="$role" \
    --condition=None >/dev/null
}

bind_project_role "roles/run.admin"
bind_project_role "roles/cloudsql.admin"
bind_project_role "roles/secretmanager.admin"
bind_project_role "roles/artifactregistry.admin"
bind_project_role "roles/compute.networkAdmin"
bind_project_role "roles/servicenetworking.networksAdmin"
bind_project_role "roles/iam.serviceAccountAdmin"
bind_project_role "roles/iam.serviceAccountUser"
bind_project_role "roles/resourcemanager.projectIamAdmin"
bind_project_role "roles/logging.admin"
# Cloud Build (image build) + push to Artifact Registry.
bind_project_role "roles/cloudbuild.builds.editor"

echo "    roles/storage.objectAdmin @ gs://${STATE_BUCKET}"
gsutil iam ch "serviceAccount:${SA_EMAIL}:roles/storage.objectAdmin" "gs://${STATE_BUCKET}" >/dev/null

# =============================================================================
# Outputs
# =============================================================================
cat <<EOF

==============================================================================
Bootstrap complete.

OpenTofu backend (pass to: tofu init -backend-config=...):
  bucket = "${STATE_BUCKET}"
  prefix = "${STATE_PREFIX}"

GitHub Actions OIDC login (set as repo variables on ${REPO}):
  GCP_PROJECT_ID            = ${PROJECT_ID}
  GCP_PROJECT_NUMBER        = ${PROJECT_NUMBER}
  GCP_WIF_PROVIDER          = ${PROVIDER_NAME}
  GCP_SERVICE_ACCOUNT       = ${SA_EMAIL}

  # google-github-actions/auth@v2 step:
  #   workload_identity_provider: \${{ vars.GCP_WIF_PROVIDER }}
  #   service_account:            \${{ vars.GCP_SERVICE_ACCOUNT }}

Example init for iac/gcp/:
  tofu init \\
    -backend-config="bucket=${STATE_BUCKET}" \\
    -backend-config="prefix=${STATE_PREFIX}"
==============================================================================
EOF
