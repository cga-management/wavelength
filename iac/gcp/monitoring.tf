# Central observability. Unlike Azure (an explicit Log Analytics workspace wired to
# the Container Apps env), Cloud Run ships logs to Cloud Logging automatically. The
# only landing-zone knob is retention on the project's _Default log bucket - set it
# to match the Azure workspace retention.
resource "google_logging_project_bucket_config" "default" {
  project        = var.project_id
  location       = "global"
  bucket_id      = "_Default"
  retention_days = var.log_retention_days
  depends_on     = [google_project_service.apis]
}
