# Outline on Cloud Run. Two containers in one service (Cloud Run v2 multi-container,
# shared localhost): the Outline app (ingress, port 3000) and a Redis sidecar that
# Outline uses for cache / rate-limit / websocket pub-sub. The sidecar is ephemeral
# and per-instance, which is why this service is pinned to a single instance (see
# variables.tf); multi-instance needs Memorystore for shared pub-sub.
#
# Ingress is INTERNAL_LOAD_BALANCER: the service is reachable ONLY through the shared
# external LB (lb.tf), never on a public *.run.app URL and never directly from the
# VPC. That also sidesteps the org's domain-restricted-sharing block on `allUsers`
# invokers - there is no public invoker binding to make.

resource "google_cloud_run_v2_service" "outline" {
  name                = "${var.workload}-outline-${var.environment}"
  location            = var.region
  ingress             = "INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCER"
  deletion_protection = false # test service; allow tofu to replace/destroy

  # The service-level `scaling` block (distinct from template.scaling, where our real
  # min/max live) perpetually diffs 0 <-> null on the google provider. Ignore it so
  # plans stay clean.
  lifecycle {
    ignore_changes = [scaling]
  }

  # Cost attribution: the billing export keys Cloud Run cost on the RUNNING REVISION's
  # labels, so `app` must be on the template (revision) as well as the service. Labels
  # are not retroactive - a redeploy is needed before cost rows carry the label.
  labels = merge(local.lz.labels, { app = "outline" })

  template {
    labels          = merge(local.lz.labels, { app = "outline" })
    service_account = local.lz.app_service_account_email

    scaling {
      # Pinned to one instance while Redis is a sidecar (non-shared pub-sub).
      min_instance_count = var.outline_min_instances
      max_instance_count = var.outline_max_instances
    }

    # ALL_TRAFFIC: Outline needs the private Cloud SQL IP (RFC1918, over the VPC) AND
    # public egress for OIDC token calls and the GCS S3 endpoint.
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = local.lz.network_id
        subnetwork = local.lz.subnet_id
      }
    }

    # Uploads bucket mounted via gcsfuse (durable, no SA key; see storage.tf).
    volumes {
      name = "uploads"
      gcs {
        bucket    = google_storage_bucket.outline.name
        read_only = false
      }
    }

    # --- Redis sidecar -------------------------------------------------------
    containers {
      name  = "redis"
      image = local.redis_image
      resources {
        limits = {
          cpu    = "1"
          memory = "256Mi"
        }
      }
      # No ports block: sidecars are not the ingress container. Outline reaches it on
      # localhost:6379 (shared network namespace).
      # Required because the outline container depends_on this one: Cloud Run needs a
      # startup probe to know when the dependency is "started".
      startup_probe {
        tcp_socket {
          port = 6379
        }
        period_seconds    = 5
        failure_threshold = 10
        timeout_seconds   = 3
      }
    }

    # --- Outline app (ingress container) -------------------------------------
    containers {
      name  = "outline"
      image = local.outline_image
      # Run pending DB migrations, then serve. Idempotent: re-running migrate on an
      # up-to-date schema is a no-op, so this is safe on every revision start.
      # Run migrations then start, WITHOUT yarn: the image's global yarn is 1.x but the
      # project pins yarn@4 via Corepack, so `yarn ...` fails to start. Call the
      # sequelize CLI and node directly instead. NODE_ENV=production keeps SSL on (Cloud
      # SQL is ENCRYPTED_ONLY); PGSSLMODE below relaxes chain verification for the
      # private-IP cert. Migrations are idempotent, so this is safe on every start.
      command = ["sh", "-c"]
      args    = ["node_modules/.bin/sequelize db:migrate && node build/server/index.js"]

      ports {
        container_port = 3000
      }
      resources {
        limits = {
          cpu    = var.outline_cpu
          memory = var.outline_memory
        }
      }
      # Start Redis before Outline so the first cache/queue connection succeeds.
      depends_on = ["redis"]

      # Outline runs DB migrations before it listens, so give startup generous headroom
      # (default ~240s can be tight on a larger/forked DB): ~300s here.
      startup_probe {
        tcp_socket {
          port = 3000
        }
        initial_delay_seconds = 10
        period_seconds        = 10
        failure_threshold     = 30
        timeout_seconds       = 5
      }

      # --- Core ---
      # Selects the SSL-enabled sequelize config for migrations and Outline's prod mode.
      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "URL"
        value = local.outline_url
      }
      # PORT is injected automatically by Cloud Run (from ports.container_port = 3000);
      # it is a reserved env name and must not be set explicitly.
      # TLS terminates at the load balancer; the app speaks plain HTTP behind it.
      env {
        name  = "FORCE_HTTPS"
        value = "false"
      }
      env {
        name = "SECRET_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.secret_key.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "UTILS_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.utils_secret.secret_id
            version = "latest"
          }
        }
      }

      # --- Database (shared Cloud SQL, private IP; URL built in the landing zone) ---
      env {
        name = "DATABASE_URL"
        value_source {
          secret_key_ref {
            secret  = local.lz.outline_database_url_secret_id
            version = "latest"
          }
        }
      }
      # SSL handling comes from the DATABASE_URL (sslmode=require&uselibpqcompat=true =
      # encrypt without verifying the private-IP cert). No PGSSLMODE env: the newer pg
      # parser rejects "no-verify", and a child migration script re-validates it.

      # --- Redis (sidecar) ---
      env {
        name  = "REDIS_URL"
        value = "redis://localhost:6379"
      }

      # --- File storage: gcsfuse-mounted bucket used as Outline "local" storage ---
      # (org policy forbids the SA/HMAC key that S3-interop would need; gcsfuse uses
      # the SA's IAM instead. The bucket is mounted at /data; see volumes below.)
      env {
        name  = "FILE_STORAGE"
        value = "local"
      }
      env {
        name  = "FILE_STORAGE_LOCAL_ROOT_DIR"
        value = "/data"
      }

      volume_mounts {
        name       = "uploads"
        mount_path = "/data"
      }

      # --- SSO: Outline's native OIDC (Entra worked example; see oidc.tf/variables.tf) ---
      env {
        name  = "OIDC_CLIENT_ID"
        value = local.oidc_client_id
      }
      env {
        name = "OIDC_CLIENT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.oidc_client_secret.secret_id
            version = "latest"
          }
        }
      }
      env {
        name  = "OIDC_AUTH_URI"
        value = local.oidc_auth_uri
      }
      env {
        name  = "OIDC_TOKEN_URI"
        value = local.oidc_token_uri
      }
      env {
        name  = "OIDC_USERINFO_URI"
        value = local.oidc_userinfo_uri
      }
      # Entra v2 reliably emits preferred_username, not always email (same lesson the
      # gateway oauth2-proxy encodes). Override oidc_username_claim for another IdP.
      env {
        name  = "OIDC_USERNAME_CLAIM"
        value = var.oidc_username_claim
      }
      env {
        name  = "OIDC_DISPLAY_NAME"
        value = var.oidc_display_name
      }
      env {
        name  = "OIDC_SCOPES"
        value = var.oidc_scopes
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.secret_key,
    google_secret_manager_secret_version.utils_secret,
    google_secret_manager_secret_version.oidc_client_secret,
  ]
}
