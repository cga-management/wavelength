# The deploy-schedule tick (src/scheduler.js): an out-of-process Cloud Run Job, same
# doctrine as the collector (collector.tf) - a DEDICATED, SCOPED service account, never
# the shared app SA and never the portal SA. The one grant that distinguishes it from
# the collector is read access to portal-github-token: the tick dispatches deploy and
# update workflows through the same GitHub token the portal uses, so the token's blast
# radius stays exactly what docs/portal.md promises (actions:write on the platform repo,
# nothing else) - it is merely readable by one more single-purpose identity.
#
# The Cloud Scheduler API is enabled by collector.tf (google_project_service.scheduler);
# not redeclared here.

resource "google_service_account" "scheduler" {
  account_id   = "id-${var.workload}-scheduler"
  display_name = "Wavelength portal deploy scheduler"
}

# --- The scheduler's ONLY grants ---------------------------------------------
# Connect to the shared Cloud SQL (read/advance deploy_schedules, write deployments).
resource "google_project_iam_member" "scheduler_cloudsql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.scheduler.email}"
}

# Pull the shared portal image (the scheduler shares the app image, different entrypoint).
resource "google_project_iam_member" "scheduler_artifact_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.scheduler.email}"
}

# Read the portal DB connection string (same reuse as the collector; both operate on
# wl_admin). Secret-scoped, not project-wide.
resource "google_secret_manager_secret_iam_member" "scheduler_db_url" {
  secret_id = google_secret_manager_secret.portal_database_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.scheduler.email}"
}

# Read the dispatch token (secret-scoped). The collector never had this; the scheduler's
# whole job is dispatching, so the binding lands here alone.
resource "google_secret_manager_secret_iam_member" "scheduler_github_token" {
  secret_id = google_secret_manager_secret.portal_github_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.scheduler.email}"
}

# --- The scheduler job (shared image, scheduler entrypoint) --------------------
resource "google_cloud_run_v2_job" "scheduler" {
  name                = "${var.workload}-scheduler-${var.environment}"
  location            = var.region
  deletion_protection = false
  labels              = merge(local.lz.labels, { app = "portal-scheduler" })

  template {
    template {
      service_account = google_service_account.scheduler.email
      # NEVER retry a tick: rows are advanced before dispatch (at-most-once), but a
      # retried tick that died between advance and dispatch would still re-run the
      # whole tick for nothing. The next scheduled tick converges anyway.
      max_retries = 0
      timeout     = "300s"

      vpc_access {
        egress = "ALL_TRAFFIC" # private Cloud SQL over the VPC + the public GitHub API
        network_interfaces {
          network    = local.lz.network_id
          subnetwork = local.lz.subnet_id
        }
      }

      containers {
        image   = local.portal_image
        command = ["node"]
        args    = ["src/scheduler.js"]

        resources {
          limits = {
            cpu    = var.scheduler_cpu
            memory = var.scheduler_memory
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
        # github.js requires this at import time (the repo hosting the workflows).
        env {
          name  = "PORTAL_PLATFORM_REPO"
          value = var.platform_repo
        }
        # Same wiring rule as the portal service (run.tf): the token env exists only
        # once a secret version is seeded. Without it the tick still runs and disables
        # due schedules with a visible "dispatch token not configured" reason.
        dynamic "env" {
          for_each = var.github_token_wired ? [1] : []
          content {
            name = "PORTAL_GITHUB_TOKEN"
            value_source {
              secret_key_ref {
                secret  = google_secret_manager_secret.portal_github_token.secret_id
                version = "latest"
              }
            }
          }
        }
      }
    }
  }

  # The job mounts the two portal secrets as the scheduler SA and pulls the shared
  # image, so the bindings must exist AND have propagated before Cloud Run's create-time
  # access check runs (same race as the collector job / portal service).
  depends_on = [
    google_secret_manager_secret_version.portal_database_url,
    google_secret_manager_secret_iam_member.scheduler_db_url,
    google_secret_manager_secret_iam_member.scheduler_github_token,
    google_project_iam_member.scheduler_artifact_reader,
  ]
}

# Cloud Scheduler needs run.jobs.run on the job to trigger it; it authenticates as the
# scheduler SA (reused as the trigger identity to keep SAs minimal, like the collector).
resource "google_cloud_run_v2_job_iam_member" "scheduler_invoker" {
  project  = var.project_id
  location = var.region
  name     = google_cloud_run_v2_job.scheduler.name
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.scheduler.email}"
}

resource "google_cloud_scheduler_job" "scheduler" {
  name             = "${var.workload}-scheduler-${var.environment}"
  region           = var.region
  schedule         = var.scheduler_tick
  time_zone        = "Etc/UTC"
  attempt_deadline = "320s"

  http_target {
    http_method = "POST"
    uri         = "https://${var.region}-run.googleapis.com/apis/run.googleapis.com/v1/namespaces/${var.project_id}/jobs/${google_cloud_run_v2_job.scheduler.name}:run"
    oauth_token {
      service_account_email = google_service_account.scheduler.email
    }
  }

  depends_on = [
    google_project_service.scheduler,
    google_cloud_run_v2_job_iam_member.scheduler_invoker,
  ]
}
