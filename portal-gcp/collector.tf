# Layer 2 collectors (docs/portal.md, cost-showback.md, usage-telemetry.md): out-of-process
# scheduled jobs that populate cost_snapshots / usage_snapshots. They run under a DEDICATED,
# SCOPED service account - NEVER the shared app runtime SA. The shared SA is inherited by
# every tenant app; a billing/BigQuery-read grant on it would cascade to all of them, which
# is precisely the blast-radius mistake the platform's least-privilege stance exists to
# prevent. One collector SA, one job, one schedule.

# Cloud Scheduler is not enabled by the landing zone; enable it here (additive, and
# disable_on_destroy = false so teardown never yanks it from under a sibling).
resource "google_project_service" "scheduler" {
  project            = var.project_id
  service            = "cloudscheduler.googleapis.com"
  disable_on_destroy = false
}

resource "google_service_account" "collector" {
  account_id   = "id-${var.workload}-collector"
  display_name = "Wavelength portal telemetry collector"
}

# --- The collector's ONLY grants -------------------------------------------
# Run BigQuery jobs (query the billing export + log sink).
resource "google_project_iam_member" "collector_bq_job" {
  project = var.project_id
  role    = "roles/bigquery.jobUser"
  member  = "serviceAccount:${google_service_account.collector.email}"
}

# Read the telemetry dataset ONLY (dataset-scoped, not project-wide bigquery.dataViewer).
# dataset_iam_member is additive - it adds one binding without rewriting the dataset the
# landing zone owns.
resource "google_bigquery_dataset_iam_member" "collector_telemetry_reader" {
  project    = var.project_id
  dataset_id = local.lz.telemetry_dataset_id
  role       = "roles/bigquery.dataViewer"
  member     = "serviceAccount:${google_service_account.collector.email}"
}

# Connect to the shared Cloud SQL (compute pg_database_size shares; write snapshot rows).
resource "google_project_iam_member" "collector_cloudsql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.collector.email}"
}

# Read Cloud Run instance metrics for the uptime signal.
resource "google_project_iam_member" "collector_monitoring" {
  project = var.project_id
  role    = "roles/monitoring.viewer"
  member  = "serviceAccount:${google_service_account.collector.email}"
}

# Read the portal DB connection string (reuse portal-database-url rather than mint a
# second DB user; both operate on wl_admin). Secret-scoped, not project-wide.
resource "google_secret_manager_secret_iam_member" "collector_db_url" {
  secret_id = google_secret_manager_secret.portal_database_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.collector.email}"
}

# Pull the shared portal image from Artifact Registry (the collector shares the app image,
# different entrypoint).
resource "google_project_iam_member" "collector_artifact_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.collector.email}"
}

# --- The collector job (shared image, collector entrypoint) ----------------
resource "google_cloud_run_v2_job" "collector" {
  name                = "${var.workload}-collector-${var.environment}"
  location            = var.region
  deletion_protection = false
  labels              = merge(local.lz.labels, { app = "portal-collector" })

  template {
    template {
      service_account = google_service_account.collector.email
      # cost then usage in one execution ("all"). Idempotent upserts, so a retry converges.
      max_retries = 1
      timeout     = "900s"

      vpc_access {
        egress = "ALL_TRAFFIC" # private Cloud SQL over the VPC + public BigQuery/Monitoring APIs
        network_interfaces {
          network    = local.lz.network_id
          subnetwork = local.lz.subnet_id
        }
      }

      containers {
        image   = local.portal_image
        command = ["node"]
        args    = ["src/collector.js", "all"]

        resources {
          limits = {
            cpu    = var.collector_cpu
            memory = var.collector_memory
          }
        }

        env {
          name = "DATABASE_URL"
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.portal_database_url.secret_id
              version = "latest"
            }
          }
        }
        env {
          name  = "GCP_PROJECT_ID"
          value = var.project_id
        }
        env {
          name  = "GCP_REGION"
          value = var.region
        }
        env {
          name  = "GCP_WORKLOAD"
          value = var.workload
        }
        env {
          name  = "GCP_ENVIRONMENT"
          value = var.environment
        }
        env {
          name  = "TELEMETRY_DATASET"
          value = local.lz.telemetry_dataset_id
        }
        # In email mode the usage collector also stores the 30d per-app user list; in
        # hashed mode it stores counts only. The collector never needs the salt itself -
        # tokens arrive pre-hashed in the log lines.
        env {
          name  = "USAGE_IDENTITY_MODE"
          value = try(local.lz.usage_identity_mode, "email")
        }
      }
    }
  }

  # The job mounts portal-database-url as the collector SA and pulls the shared image, so
  # both IAM grants must exist AND have propagated before Cloud Run's create-time access
  # check runs (a missing dependency here races the binding and fails with "Permission
  # denied on secret").
  depends_on = [
    google_secret_manager_secret_version.portal_database_url,
    google_secret_manager_secret_iam_member.collector_db_url,
    google_project_iam_member.collector_artifact_reader,
  ]
}

# Cloud Scheduler needs run.jobs.run on the job to trigger it; it authenticates as the
# collector SA (reused as the trigger identity to keep SAs minimal).
resource "google_cloud_run_v2_job_iam_member" "collector_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.collector.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.collector.email}"
}

resource "google_cloud_scheduler_job" "collector" {
  name             = "${var.workload}-collector-${var.environment}"
  region           = var.region
  schedule         = var.collector_schedule
  time_zone        = "Etc/UTC"
  attempt_deadline = "320s"

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.collector.name}:run"
    oauth_token {
      service_account_email = google_service_account.collector.email
    }
  }

  depends_on = [
    google_project_service.scheduler,
    google_cloud_run_v2_job_iam_member.collector_invoker,
  ]
}
