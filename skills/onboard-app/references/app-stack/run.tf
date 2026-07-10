# myapp on Cloud Run: scale-to-zero, internal ingress (reachable ONLY via the IAP LB),
# runs as the shared app service account, reaches the private Cloud SQL over Direct VPC
# egress. No public invoker is ever granted - IAP is enforced on the LB backend (lb.tf).
resource "google_cloud_run_v2_service" "app" {
  name                = "${var.workload}-myapp-${var.environment}"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  deletion_protection = false

  # Cost attribution: the billing export keys Cloud Run cost on the RUNNING REVISION's
  # labels, so `app` must be on the template (revision) as well as the service. Labels
  # are not retroactive - a redeploy is needed before cost rows carry the label.
  labels = merge(local.lz.labels, { app = "myapp" })

  template {
    labels          = merge(local.lz.labels, { app = "myapp" })
    service_account = local.lz.app_service_account_email

    scaling {
      min_instance_count = 0 # scale to zero
      max_instance_count = 2
    }

    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = local.lz.network_id
        subnetwork = local.lz.subnet_id
      }
    }

    containers {
      image = local.app_image

      # Match your app's listen port. Cloud Run also sets $PORT; bind 0.0.0.0:$PORT.
      ports { container_port = 8080 }

      startup_probe {
        tcp_socket { port = 8080 }
        initial_delay_seconds = 5
        period_seconds        = 5
        failure_threshold     = 20
      }

      # Shared DB connection string. The secret (and the database + app user it points
      # at) is created by THIS stack on first apply - see database.tf.
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.database_url.secret_id
            version = "latest"
          }
        }
      }

      # Verified-identity audience (two-phase; see README). App fails closed if empty.
      env {
        name  = "IAP_AUDIENCE"
        value = var.iap_audience
      }

      # Owner = deploying dev, always admin (see ../shared-db-rls.md).
      env {
        name  = "APP_OWNER_EMAIL"
        value = var.app_owner_email
      }

      env {
        name  = "APP_ENV"
        value = "platform"
      }

      # API keys: add one env per key, sourced from Secret Manager (see ../secrets.md), e.g.
      # env {
      #   name = "OPENAI_API_KEY"
      #   value_source { secret_key_ref { secret = "myapp-openai-api-key", version = "latest" } }
      # }
    }
  }

  # Cloud Run v2 can show a perpetual scaling diff; uncomment if you see one after apply.
  # lifecycle { ignore_changes = [template[0].scaling] }
}
