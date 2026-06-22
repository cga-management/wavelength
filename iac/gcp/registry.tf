# Artifact Registry for app images (the ACR analogue). Pulls are via the app's
# service account (roles/artifactregistry.reader, granted in identity.tf), never a
# static credential. Images are built with `gcloud builds submit` (no local Docker).
resource "google_artifact_registry_repository" "platform" {
  repository_id = "ar-${var.workload}-${var.environment}"
  location      = var.region
  format        = "DOCKER"
  description   = "Wavelength platform container images"
  labels        = local.labels
  depends_on    = [google_project_service.apis]
}
