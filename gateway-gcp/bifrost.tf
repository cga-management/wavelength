# Bifrost engine on Cloud Run (Ring 2 - internal only). Apps call it at
# https://<url>/anthropic/v1/messages with their virtual key in x-api-key. The admin
# UI is reached only through the OIDC-gated oauth2-proxy (oauth2proxy.tf).
#
# The image (../gateway/bifrost/) is reused UNCHANGED: config.json is rendered at
# boot by wl-entrypoint.sh from env vars. Secret values arrive via Secret Manager
# references (the Key Vault analogue); nothing secret is in the image, the repo, or
# this stack's plaintext config.

locals {
  bifrost_image = "${local.lz.artifact_registry_repo}/wavelength-bifrost:${var.bifrost_image_tag}"
}

# drum's virtual key value. Declared here (not minted in the UI) so it is stable
# across restarts: Bifrost seeds it from config.json on boot (value arrives via
# env.WL_DRUM_VIRTUAL_KEY). Bifrost requires the sk-bf prefix.
resource "random_password" "drum_virtual_key" {
  length  = 40
  special = false
}

resource "google_secret_manager_secret" "drum_virtual_key" {
  secret_id = "drum-virtual-key"
  labels    = local.lz.labels
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "drum_virtual_key" {
  secret      = google_secret_manager_secret.drum_virtual_key.id
  secret_data = "sk-bf-${random_password.drum_virtual_key.result}"
}

# Encrypts secrets at rest inside Bifrost's config store. NOTE: once set, do not
# rotate casually - Bifrost cannot decrypt stored values under a different key.
resource "random_password" "bifrost_encryption_key" {
  length  = 48
  special = false
}

resource "google_secret_manager_secret" "bifrost_encryption_key" {
  secret_id = "bifrost-encryption-key"
  labels    = local.lz.labels
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "bifrost_encryption_key" {
  secret      = google_secret_manager_secret.bifrost_encryption_key.id
  secret_data = random_password.bifrost_encryption_key.result
}

resource "google_cloud_run_v2_service" "bifrost" {
  name     = "${var.workload}-bifrost-${var.environment}"
  location = var.region
  # Internal only - admitted only for traffic originating inside the VPC (the public
  # oauth2-proxy reaches it by routing through the VPC; see oauth2proxy.tf).
  ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = local.lz.app_service_account_email

    scaling {
      min_instance_count = var.bifrost_min_instances # shared service: keep warm
      # Headroom so a browser's asset burst (and any UI retry) doesn't hit Cloud Run's
      # hard 429 "Rate exceeded." at a low instance ceiling.
      max_instance_count = 8
    }

    # Direct VPC egress: reach the private Cloud SQL IP over the VPC. PRIVATE_RANGES_ONLY
    # routes only RFC1918 through the VPC, so Bifrost's public Anthropic calls take
    # Google's default egress (no Cloud NAT dependency).
    vpc_access {
      egress = "PRIVATE_RANGES_ONLY"
      network_interfaces {
        network    = local.lz.network_id
        subnetwork = local.lz.subnet_id
      }
    }

    containers {
      image = local.bifrost_image
      ports {
        container_port = 8080
      }
      resources {
        limits = {
          cpu    = var.bifrost_cpu
          memory = var.bifrost_memory
        }
      }

      # Substituted into config.json at boot by wl-entrypoint.sh.
      env {
        name  = "WL_DB_HOST"
        value = local.lz.db_private_ip
      }
      env {
        name  = "WL_DB_USER"
        value = var.db_admin_login
      }
      env {
        name = "WL_DB_PASSWORD"
        value_source {
          secret_key_ref {
            secret  = local.lz.db_password_secret_id
            version = "latest"
          }
        }
      }
      # Resolved by Bifrost itself (env.X references inside config.json).
      env {
        name = "ANTHROPIC_API_KEY"
        value_source {
          secret_key_ref {
            secret  = local.lz.anthropic_secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "REPLICATE_API_KEY"
        value_source {
          secret_key_ref {
            secret  = local.lz.replicate_secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "WL_DRUM_VIRTUAL_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.drum_virtual_key.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "BIFROST_ENCRYPTION_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.bifrost_encryption_key.secret_id
            version = "latest"
          }
        }
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.drum_virtual_key,
    google_secret_manager_secret_version.bifrost_encryption_key,
  ]
}

# Round-1 posture: network protection is internal ingress + VPC origin; app auth is
# Bifrost's own virtual-key enforcement (enforce_auth_on_inference). Allow unauth at
# the IAM layer so the in-VPC oauth2-proxy call needs no Google ID token. Harden to
# a dedicated invoker SA + ID token later.
resource "google_cloud_run_v2_service_iam_member" "bifrost_invoker" {
  name     = google_cloud_run_v2_service.bifrost.name
  location = google_cloud_run_v2_service.bifrost.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}
