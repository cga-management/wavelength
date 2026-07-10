# Usage-telemetry capture for the platform admin portal. Policy: usage reporting is
# AGGREGATE-ONLY (unique users, average users per day, uptime) - the authenticated
# principal in each audit entry is read transiently to deduplicate users, and only
# the aggregates are ever surfaced. Two signals land in one BigQuery dataset via a
# log sink: the external HTTPS LB request logs (traffic + uptime) and the IAP
# data-access audit entries (which carry the principal). Sinks capture only from
# creation onward - nothing is retroactive - which is why this lives in the landing
# zone and not in the (later) portal stack.

resource "google_bigquery_dataset" "telemetry" {
  # BigQuery dataset ids allow only [a-zA-Z0-9_] - no dashes - so this deviates from
  # the <type>-<workload>-<environment> convention and sanitises the workload token.
  dataset_id = "${replace(var.workload, "-", "_")}_telemetry"
  project    = var.project_id
  # No other BigQuery usage exists in the platform to follow; co-locate with the
  # workloads (var.region) rather than a multi-region, matching every other resource.
  location    = var.region
  description = "Platform usage telemetry (LB request logs + IAP data-access audit entries), filled by the telemetry log sink."
  labels      = local.labels

  # Telemetry history is the whole point - never let a destroy take the data with it.
  delete_contents_on_destroy = false

  depends_on = [google_project_service.apis]
}

# Routes the two usage signals into the dataset. unique_writer_identity gives the sink
# its own service account (granted below); partitioned tables keep the dataset queryable
# and cheap as it grows.
resource "google_logging_project_sink" "telemetry" {
  name        = "${var.workload}-telemetry-${var.environment}"
  project     = var.project_id
  destination = "bigquery.googleapis.com/projects/${var.project_id}/datasets/${google_bigquery_dataset.telemetry.dataset_id}"

  # (a) external HTTPS LB request logs - per-request traffic and uptime signal;
  # (b) IAP data-access audit entries - the authenticated principal, for unique-user
  #     counts (requires the audit config below to be emitted at all).
  filter = <<-EOT
    resource.type="http_load_balancer" OR (
      logName="projects/${var.project_id}/logs/cloudaudit.googleapis.com%2Fdata_access"
      AND protoPayload.serviceName="iap.googleapis.com"
    )
  EOT

  unique_writer_identity = true

  bigquery_options {
    use_partitioned_tables = true
  }
}

# The sink's generated writer identity needs to create/append the export tables.
resource "google_project_iam_member" "telemetry_sink_writer" {
  project = var.project_id
  role    = "roles/bigquery.dataEditor"
  member  = google_logging_project_sink.telemetry.writer_identity
}

# Emit IAP DATA_READ audit entries: these are what record the authenticated principal
# per request, without which unique-user counts are impossible. NOTE: audit-log volume
# is proportional to request traffic through IAP - accepted, as it is the usage signal.
resource "google_project_iam_audit_config" "iap" {
  project = var.project_id
  service = "iap.googleapis.com"

  audit_log_config {
    log_type = "DATA_READ"
  }
}
