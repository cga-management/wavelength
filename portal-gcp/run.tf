# Portal on Cloud Run: scale-to-zero, internal ingress (reachable ONLY via the shared IAP
# LB - never on a public *.run.app URL), runs as its OWN dedicated service account
# (id-wl-portal, identity.tf) rather than the shared app SA - the third sanctioned
# deviation: the portal now holds one read-only cloud capability (Cloud Logging read for
# the per-app Logs panel), kept off the shared tenant SA so it cannot cascade. Reaches the
# private Cloud SQL over Direct VPC egress. No public invoker is ever granted - IAP is
# enforced on the LB backend (lb.tf).
resource "google_cloud_run_v2_service" "portal" {
  name                = "${var.workload}-portal-${var.environment}"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  deletion_protection = false

  # The service-level scaling block perpetually diffs 0 <-> null on the google provider;
  # our real min/max live in template.scaling. Ignore it so plans stay clean.
  lifecycle {
    ignore_changes = [scaling]
  }

  # Cost attribution: the billing export keys Cloud Run cost on the RUNNING REVISION's
  # labels, so `app` must be on the template (revision) as well as the service.
  labels = merge(local.lz.labels, { app = "portal" })

  template {
    labels          = merge(local.lz.labels, { app = "portal" })
    service_account = google_service_account.portal.email

    scaling {
      min_instance_count = var.portal_min_instances
      max_instance_count = var.portal_max_instances
    }

    # ALL_TRAFFIC: the portal needs the private Cloud SQL IP (RFC1918, over the VPC) AND
    # public egress (the GitHub API for deploy dispatch, and Google's IAP JWKS at
    # www.gstatic.com for JWT verification).
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = local.lz.network_id
        subnetwork = local.lz.subnet_id
      }
    }

    containers {
      image = local.portal_image

      ports { container_port = 8080 }

      startup_probe {
        tcp_socket { port = 8080 }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 20
      }

      resources {
        limits = {
          cpu    = var.portal_cpu
          memory = var.portal_memory
        }
      }

      # Shared wl_admin connection string (portal_app user; see database.tf).
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.portal_database_url.secret_id
            version = "latest"
          }
        }
      }

      # Verified-identity audience (two-phase; see README). Portal fails closed if empty.
      env {
        name  = "IAP_AUDIENCE"
        value = var.iap_audience
      }

      env {
        name  = "APP_ENV"
        value = "platform"
      }
      env {
        name  = "GCP_PROJECT_ID"
        value = var.project_id
      }
      # workload + environment let the Logs panel derive an app's Cloud Run service name
      # (wl-<slug>-platform) for the Cloud Logging filter.
      env {
        name  = "GCP_WORKLOAD"
        value = var.workload
      }
      env {
        name  = "GCP_ENVIRONMENT"
        value = var.environment
      }
      # Backups panel: the bucket deploy-app.yml exports pre-deploy dumps into (the panel
      # lists it; platform admins delete from it), and the shared Cloud SQL instance name
      # for the read-only protection-status lookup via cloudsql.viewer (identity.tf).
      env {
        name  = "DB_PRE_DEPLOY_BUCKET"
        value = local.lz.db_pre_deploy_bucket
      }
      env {
        name  = "SQL_INSTANCE_NAME"
        value = local.lz.db_instance_name
      }
      env {
        name  = "PORTAL_HOSTNAME"
        value = var.portal_hostname
      }
      env {
        name  = "PORTAL_APP_DOMAIN"
        value = local.app_domain
      }
      env {
        name  = "PORTAL_BOOTSTRAP_ADMIN"
        value = var.bootstrap_admin_email
      }
      env {
        name  = "PORTAL_PLATFORM_REPO"
        value = var.platform_repo
      }

      # Usage-telemetry identity mode (docs/usage-telemetry.md): the platform-wide
      # posture chosen on the landing zone. Drives the portal's own wl.auth line AND
      # whether the app-detail page shows the Users (30d) list. try() tolerates a
      # landing zone that predates the output (defaults to email mode).
      env {
        name  = "USAGE_IDENTITY_MODE"
        value = try(local.lz.usage_identity_mode, "email")
      }

      # Platform-wide usage-hash salt, read ONLY in hashed mode. The portal SA is
      # per-secret scoped, so identity.tf grants it secretAccessor on exactly this
      # landing-zone secret. Omitted entirely (dynamic) when the landing zone predates
      # the salt secret; the identity layer then falls back to email mode.
      dynamic "env" {
        for_each = try(local.lz.usage_hash_salt_secret_id, null) != null ? [1] : []
        content {
          name = "USAGE_HASH_SALT"
          value_source {
            secret_key_ref {
              secret  = try(local.lz.usage_hash_salt_secret_id, null)
              version = "latest"
            }
          }
        }
      }

      # The deploy-dispatch token, wired only once a secret version is seeded (see
      # secrets.tf / var.github_token_wired). Absent -> Deploy button disabled.
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

  # The revision mounts the portal secrets as the DEDICATED portal SA and pulls the
  # shared image, so the SA's secret bindings (and the versions) must exist AND have
  # propagated before Cloud Run's create-time access check runs - otherwise the first
  # revision under the new SA races the binding and fails "Permission denied on secret".
  # The usage-hash salt binding is in the list for the same reason; the salt secret and
  # its version themselves live in the landing zone (applied before this stack), so
  # only the IAM member can be a depends_on here.
  depends_on = [
    google_secret_manager_secret_version.portal_database_url,
    google_secret_manager_secret_iam_member.portal_database_url,
    google_secret_manager_secret_iam_member.portal_github_token,
    google_secret_manager_secret_iam_member.portal_usage_hash_salt,
    google_project_iam_member.portal_artifact_reader,
  ]
}
