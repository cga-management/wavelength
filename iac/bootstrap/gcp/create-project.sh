#!/usr/bin/env bash
# Step -1 (GCP): provision the PROJECT the platform lives in.
#
# GCP's equivalent of an Azure subscription is a PROJECT - the resource, IAM and
# billing boundary. It is created under an Organization (optionally a Folder) and
# linked to a Billing Account. See ../README.md for the cross-cloud pattern.
#
# Privileges (a billing/org-admin act - may be handed off; use --spec):
#   - resourcemanager.projects.create (Project Creator, at the org or folder)
#   - billing.resourceAssociations.create (Billing Account User) to link billing
#
# Usage:
#   ORG_ID=<numeric-org-id> BILLING_ACCOUNT=XXXXXX-XXXXXX-XXXXXX ./create-project.sh
# Optional overrides:
#   PROJECT_ID=my-wl-123456     # default: <WORKLOAD>-platform-<6 random digits>
#   FOLDER_ID=<numeric>         # place the project in a folder INSTEAD of ORG_ID
#   DISPLAY_NAME="Wavelength Platform"
#   WORKLOAD=wl                 # only used when PROJECT_ID is generated
# Spec mode (changes nothing - print the request to hand to a billing admin):
#   ./create-project.sh --spec
#
# API enablement is NOT done here: step 0 (./bootstrap.sh) enables the full set the
# landing zone needs, so this script stays a pure billing/org-admin act.
#
# Re-running is safe: every step checks before it creates.

set -euo pipefail

# --- Parameters ---------------------------------------------------------------
WORKLOAD="${WORKLOAD:-wl}"
# Project IDs are global, immutable, 6-30 lowercase alnum/hyphen. A random suffix
# avoids collisions with ids other GCP customers already claimed.
PROJECT_ID="${PROJECT_ID:-${WORKLOAD}-platform-$(printf '%06d' $(( (RANDOM * 32768 + RANDOM) % 1000000 )))}"
DISPLAY_NAME="${DISPLAY_NAME:-Wavelength Platform}"
ORG_ID="${ORG_ID:-}"
FOLDER_ID="${FOLDER_ID:-}"
BILLING_ACCOUNT="${BILLING_ACCOUNT:-}"

if [ "${1:-}" = "--spec" ]; then
  if [ -n "$FOLDER_ID" ]; then
    PARENT_FLAG="--folder=\"${FOLDER_ID}\""
  else
    PARENT_FLAG="--organization=\"${ORG_ID:-<ORG_ID>}\""
  fi
  cat <<EOF
Wavelength step -1 (GCP) - provisioning request. Run by someone holding:
  - roles/resourcemanager.projectCreator (on the org or target folder)
  - roles/billing.user (on the billing account)

  gcloud projects create "${PROJECT_ID}" \\
    --name="${DISPLAY_NAME}" ${PARENT_FLAG}
  gcloud billing projects link "${PROJECT_ID}" \\
    --billing-account="${BILLING_ACCOUNT:-<BILLING_ACCOUNT>}"

Then hand PROJECT_ID=${PROJECT_ID} back to the operator for step 0 (./bootstrap.sh).
Nothing was changed by this invocation.
EOF
  exit 0
fi

# --- Preflight ----------------------------------------------------------------
command -v gcloud >/dev/null || { echo "ERROR: gcloud not found" >&2; exit 1; }
gcloud auth list --filter=status:ACTIVE --format='value(account)' | grep -q . \
  || { echo "ERROR: run 'gcloud auth login' first" >&2; exit 1; }

if [ -n "$ORG_ID" ] && [ -n "$FOLDER_ID" ]; then
  echo "ERROR: set ORG_ID or FOLDER_ID, not both (a folder already lives in an org)" >&2
  exit 1
fi
if [ -z "$ORG_ID" ] && [ -z "$FOLDER_ID" ]; then
  echo "ERROR: set ORG_ID (numeric, from 'gcloud organizations list') or FOLDER_ID" >&2
  exit 1
fi
[ -n "$BILLING_ACCOUNT" ] \
  || { echo "ERROR: set BILLING_ACCOUNT (from 'gcloud billing accounts list')" >&2; exit 1; }

# =============================================================================
# 1. Create the project (idempotent)
# =============================================================================
if gcloud projects describe "$PROJECT_ID" >/dev/null 2>&1; then
  echo "==> Project ${PROJECT_ID} exists - skipping create"
else
  echo "==> Creating project ${PROJECT_ID} (${DISPLAY_NAME})"
  if [ -n "$FOLDER_ID" ]; then
    gcloud projects create "$PROJECT_ID" --name="$DISPLAY_NAME" --folder="$FOLDER_ID"
  else
    gcloud projects create "$PROJECT_ID" --name="$DISPLAY_NAME" --organization="$ORG_ID"
  fi
fi

# =============================================================================
# 2. Link billing (idempotent)
# =============================================================================
LINKED="$(gcloud billing projects describe "$PROJECT_ID" --format='value(billingEnabled)' 2>/dev/null || echo false)"
if [ "$LINKED" = "True" ]; then
  echo "==> Billing already enabled on ${PROJECT_ID}"
else
  echo "==> Linking billing account ${BILLING_ACCOUNT}"
  gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT" >/dev/null
fi

# =============================================================================
# Outputs
# =============================================================================
cat <<EOF

==============================================================================
Step -1 complete.

  PROJECT_ID = ${PROJECT_ID}

Next (step 0 - state backend + CI identity; also enables all required APIs):
  REPO=<github-org>/<your-private-copy> PROJECT_ID=${PROJECT_ID} ./bootstrap.sh
==============================================================================
EOF
