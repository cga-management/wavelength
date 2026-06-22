# Workload identity apps run as. Cloud Run services run AS this service account;
# it is granted read access to secrets, pull access to the registry, and the Cloud
# SQL client role - no static credentials anywhere in the app path. The analogue of
# Azure's user-assigned managed identity (id-wl-platform).
resource "google_service_account" "app" {
  account_id   = "id-${var.workload}-${var.environment}"
  display_name = "Wavelength app workload identity"
}

# Read platform secrets (the Key Vault Secrets User analogue). Project-scoped to
# match the Azure grant at vault scope; tighten to per-secret IAM if/when needed.
resource "google_project_iam_member" "app_secret_accessor" {
  project = var.project_id
  role    = "roles/secretmanager.secretAccessor"
  member  = "serviceAccount:${google_service_account.app.email}"
}

# Pull images from Artifact Registry (the AcrPull analogue).
resource "google_project_iam_member" "app_artifact_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.app.email}"
}

# Connect to Cloud SQL. (No Azure analogue - Flexible Server access was purely
# network-level; Cloud SQL pairs network reachability with this IAM role.)
resource "google_project_iam_member" "app_cloudsql_client" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.app.email}"
}
