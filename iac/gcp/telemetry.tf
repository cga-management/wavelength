# Usage-telemetry capture for the platform admin portal. Policy: usage reporting is
# AGGREGATE-BY-DEFAULT with one explicit posture choice, var.usage_identity_mode
# (docs/usage-telemetry.md): in "email" mode (default) the portal can additionally
# show WHO uses each app (that app's admins + platform admins only); in "hashed"
# mode the pipeline carries a keyed pseudonymous hash and only counts exist anywhere.
# Three signals land in one BigQuery dataset via a log sink: the external HTTPS LB
# request logs (traffic + uptime), the IAP data-access audit entries (principal, on
# plain Google-identity setups), and the apps' own wl.auth usage lines (the unique-
# user signal that works on workforce federation too). Sinks capture only from
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
  description = "Platform usage telemetry (LB request logs + IAP data-access audit entries + app wl.auth usage lines), filled by the telemetry log sink."
  labels      = local.labels

  # Retention guard (and cost hygiene): partitions age out after 90 days, so the
  # dataset never becomes a long-lived activity ledger - in EITHER identity mode the
  # per-user rows exist for at most 90 days, while the portal's aggregated snapshots
  # keep the history that matters. Applies to partitions created from now on; existing
  # partitions on an already-running instance are unaffected until they roll.
  default_partition_expiration_ms = 90 * 24 * 60 * 60 * 1000

  # Telemetry history is the whole point - never let a destroy take the data with it.
  delete_contents_on_destroy = false

  depends_on = [google_project_service.apis]
}

# Routes the three usage signals into the dataset. unique_writer_identity gives the sink
# its own service account (granted below); partitioned tables keep the dataset queryable
# and cheap as it grows.
resource "google_logging_project_sink" "telemetry" {
  name        = "${var.workload}-telemetry-${var.environment}"
  project     = var.project_id
  destination = "bigquery.googleapis.com/projects/${var.project_id}/datasets/${google_bigquery_dataset.telemetry.dataset_id}"

  # (a) external HTTPS LB request logs - per-request traffic and uptime signal;
  # (b) IAP data-access audit entries - the authenticated principal on plain
  #     Google-identity setups (requires the audit config below to be emitted at all;
  #     workforce federation emits NOTHING here - see the audit-config note);
  # (c) the apps' own wl.auth usage lines from Cloud Run stdout - the unique-user
  #     signal that works on any IdP (one structured line per user per day, emitted
  #     by the identity middleware; iap-identity.md). ONLY auth lines are routed,
  #     never general app stdout.
  filter = <<-EOT
    resource.type="http_load_balancer" OR (
      logName="projects/${var.project_id}/logs/cloudaudit.googleapis.com%2Fdata_access"
      AND protoPayload.serviceName="iap.googleapis.com"
    ) OR (
      resource.type="cloud_run_revision"
      AND logName="projects/${var.project_id}/logs/run.googleapis.com%2Fstdout"
      AND jsonPayload.event="wl.auth"
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

# Emit IAP DATA_READ audit entries: on plain Google-identity IAP these record the
# authenticated principal per request. NOTE: on a WORKFORCE-FEDERATED perimeter (the
# shape iac/gcp-org builds) IAP emits NO per-request data-access entries at all -
# verified live - which is why unique-user counting rests on the apps' own wl.auth
# lines (signal (c) above). Kept because it is correct and useful for adopters running
# plain Google identity, and harmless (zero volume) under workforce federation.
resource "google_project_iam_audit_config" "iap" {
  project = var.project_id
  service = "iap.googleapis.com"

  audit_log_config {
    log_type = "DATA_READ"
  }
}

# --- Usage-hash salt ------------------------------------------------------------
# ONE platform-wide salt for usage_identity_mode = "hashed": the identity middleware
# computes HMAC-SHA256(salt, normalized email) so usage tokens are stable per user but
# meaningless without this secret. Provisioned unconditionally (cheap; simply unread in
# email mode) so flipping the mode is a variable change + app redeploys, never a
# resource dance. One salt, not per-app: platform operators can read every app's logs
# anyway, so per-app salts would add plumbing without adding a boundary.
resource "random_password" "usage_hash_salt" {
  length  = 48
  special = false
}

resource "google_secret_manager_secret" "usage_hash_salt" {
  secret_id = "usage-hash-salt"
  labels    = local.labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "usage_hash_salt" {
  secret      = google_secret_manager_secret.usage_hash_salt.id
  secret_data = random_password.usage_hash_salt.result
}
