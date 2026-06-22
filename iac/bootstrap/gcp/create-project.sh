#!/usr/bin/env bash
# Step -1 (GCP): provision the PROJECT the platform lives in.
#
# GCP's equivalent of an Azure subscription is a PROJECT - the resource, IAM and
# billing boundary. It is created under an Organization (optionally a Folder) and
# linked to a Billing Account. Same intent as ../azure/create-subscription.sh;
# see ../README.md for the cross-cloud pattern.
#
# Privileges (a billing/org-admin act - may be handed off; use --spec):
#   - resourcemanager.projects.create (Project Creator, at the org or folder)
#   - billing.resourceAssociations.create (Billing Account User) to link billing
#
# Intended flow (implement alongside iac/gcp/):
#   gcloud projects create "$PROJECT_ID" --name="$DISPLAY_NAME" \
#     --organization="$ORG_ID"            # or --folder="$FOLDER_ID"
#   gcloud billing projects link "$PROJECT_ID" --billing-account="$BILLING_ACCOUNT"
#   # Enable required APIs - GCP's analogue of Azure provider registration:
#   gcloud services enable run.googleapis.com secretmanager.googleapis.com \
#     artifactregistry.googleapis.com sqladmin.googleapis.com \
#     logging.googleapis.com --project="$PROJECT_ID"
#
# Then step 0 (bootstrap) for GCP creates:
#   - state backend: a GCS bucket (versioned) for the tofu state
#   - CI identity: a Workload Identity Federation pool + provider bound to
#     repo:<github-org>/wavelength, plus a service account CI impersonates -
#     the GCP equivalent of Azure's Entra app + federated credential.

set -euo pipefail
echo "GCP project creator (subscription-equivalent) - spec/placeholder."
echo "See the comments in this file and ../README.md. Implement with iac/gcp/."
exit 1
