# OIDC gate for the gateway UI (oauth2-proxy on Cloud Run) - Ring 1, the only public
# surface. Bifrost stays INTERNAL; this proxy authenticates the browser against your
# OIDC IdP and reverse-proxies to Bifrost's internal URL over the VPC. Apps call
# Bifrost's internal URL directly with their key and never touch this proxy.
#
# IdP-agnostic: oauth2-proxy is a generic OIDC client. Entra ships as the worked example
# (this stack auto-creates wl-gateway-ui-gcp via the azuread provider). For another OIDC
# IdP, set create_entra_app_registration = false and supply oidc_issuer_uri /
# oidc_client_id / oidc_client_secret.

# --- IdP app registration (Entra worked example) -----------------------------
locals {
  # The callback the proxy auto-derives from Cloud Run's X-Forwarded headers. Empty
  # var on the first apply -> a placeholder so the app reg is valid; set the var on a
  # second apply (to the deployed proxy URL) so the IdP accepts the real callback.
  gcp_redirect_uri = var.oauth2_proxy_url != "" ? "${var.oauth2_proxy_url}/oauth2/callback" : "https://placeholder.example.com/oauth2/callback"

  # OIDC issuer + client: an explicit override wins; otherwise derive Entra from the
  # tenant and read the client from the auto-created app. one(...[*]...) is index-safe.
  oidc_issuer        = var.oidc_issuer_uri != "" ? var.oidc_issuer_uri : (var.entra_tenant_id != "" ? "https://login.microsoftonline.com/${var.entra_tenant_id}/v2.0" : "")
  oidc_client_id     = var.create_entra_app_registration ? one(azuread_application.gwui_gcp[*].client_id) : var.oidc_client_id
  oidc_client_secret = var.create_entra_app_registration ? one(azuread_application_password.gwui_gcp[*].value) : var.oidc_client_secret
}

resource "azuread_application" "gwui_gcp" {
  count            = var.create_entra_app_registration ? 1 : 0
  display_name     = "wl-gateway-ui-gcp"
  sign_in_audience = "AzureADMyOrg"
  web {
    redirect_uris = [local.gcp_redirect_uri]
    implicit_grant {
      id_token_issuance_enabled = true
    }
  }
}

moved {
  from = azuread_application.gwui_gcp
  to   = azuread_application.gwui_gcp[0]
}

resource "azuread_service_principal" "gwui_gcp" {
  count     = var.create_entra_app_registration ? 1 : 0
  client_id = azuread_application.gwui_gcp[0].client_id
}

moved {
  from = azuread_service_principal.gwui_gcp
  to   = azuread_service_principal.gwui_gcp[0]
}

resource "azuread_application_password" "gwui_gcp" {
  count          = var.create_entra_app_registration ? 1 : 0
  application_id = azuread_application.gwui_gcp[0].id
  display_name   = "oauth2-proxy-gcp"
}

moved {
  from = azuread_application_password.gwui_gcp
  to   = azuread_application_password.gwui_gcp[0]
}

# Cookie encryption secret (AES-256 -> 32 bytes).
resource "random_password" "oauth2_cookie" {
  length  = 32
  special = false
}

# --- Proxy secrets in Secret Manager (referenced by the Cloud Run service) ---
resource "google_secret_manager_secret" "oauth2_client_secret" {
  secret_id = "gwui-gcp-client-secret"
  labels    = local.lz.labels
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "oauth2_client_secret" {
  secret      = google_secret_manager_secret.oauth2_client_secret.id
  secret_data = local.oidc_client_secret
}

resource "google_secret_manager_secret" "oauth2_cookie_secret" {
  secret_id = "gwui-gcp-cookie-secret"
  labels    = local.lz.labels
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "oauth2_cookie_secret" {
  secret      = google_secret_manager_secret.oauth2_cookie_secret.id
  secret_data = random_password.oauth2_cookie.result
}

# --- The proxy service -------------------------------------------------------
resource "google_cloud_run_v2_service" "oauth2_proxy" {
  name     = "${var.workload}-gwui-${var.environment}"
  location = var.region
  # The only public surface. Auth happens here; the upstream Bifrost stays internal.
  ingress = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = local.lz.app_service_account_email

    scaling {
      # min 1: a browser loading the Bifrost SPA fires a burst of asset requests at
      # once. Cloud Run returns a hard 429 "Rate exceeded." when a burst outpaces its
      # ability to scale (unlike Azure Container Apps, which queues), and a cold start
      # from zero makes that worse - the first visit storms. Keeping one warm instance
      # plus headroom makes the UI reliable. (Doctrine note: this trades the proxy's
      # scale-to-zero for usability on Cloud Run; revisit if cost matters.)
      min_instance_count = 1
      max_instance_count = 4
    }

    # ALL_TRAFFIC so the call to Bifrost's internal service is sourced from the VPC
    # (admitted by INGRESS_TRAFFIC_INTERNAL_ONLY) AND the OIDC calls to Entra reach
    # the internet via Cloud NAT.
    vpc_access {
      egress = "ALL_TRAFFIC"
      network_interfaces {
        network    = local.lz.network_id
        subnetwork = local.lz.subnet_id
      }
    }

    containers {
      image = var.oauth2_proxy_image
      ports {
        container_port = 4180
      }

      env {
        name  = "OAUTH2_PROXY_PROVIDER"
        value = "oidc"
      }
      env {
        name  = "OAUTH2_PROXY_OIDC_ISSUER_URL"
        value = local.oidc_issuer
      }
      env {
        name  = "OAUTH2_PROXY_CLIENT_ID"
        value = local.oidc_client_id
      }
      env {
        name = "OAUTH2_PROXY_CLIENT_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.oauth2_client_secret.secret_id
            version = "latest"
          }
        }
      }
      env {
        name = "OAUTH2_PROXY_COOKIE_SECRET"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.oauth2_cookie_secret.secret_id
            version = "latest"
          }
        }
      }
      # Upstream is Bifrost's internal Cloud Run URL.
      env {
        name  = "OAUTH2_PROXY_UPSTREAMS"
        value = google_cloud_run_v2_service.bifrost.uri
      }
      # Entra v2 id tokens reliably carry preferred_username, not always email.
      # Override oidc_email_claim for another IdP.
      env {
        name  = "OAUTH2_PROXY_OIDC_EMAIL_CLAIM"
        value = var.oidc_email_claim
      }
      env {
        name  = "OAUTH2_PROXY_EMAIL_DOMAINS"
        value = "*"
      }
      env {
        name  = "OAUTH2_PROXY_SCOPE"
        value = "openid email profile"
      }
      env {
        name  = "OAUTH2_PROXY_HTTP_ADDRESS"
        value = "0.0.0.0:4180"
      }
      env {
        name  = "OAUTH2_PROXY_REVERSE_PROXY"
        value = "true"
      }
      env {
        name  = "OAUTH2_PROXY_COOKIE_SECURE"
        value = "true"
      }
      env {
        name  = "OAUTH2_PROXY_SKIP_PROVIDER_BUTTON"
        value = "true"
      }
      # SAME as Azure (Container Apps), and for the same reason: Cloud Run's frontend
      # ALSO routes by the Host header. With pass_host_header=true the proxy forwards
      # the browser's Host (this proxy's own hostname), so Cloud Run routes the upstream
      # call straight back to the proxy - a request loop that Cloud Run sheds as 429
      # "Rate exceeded." and Bifrost never sees. false makes the proxy send the upstream
      # (Bifrost) hostname as Host, so the frontend routes to Bifrost.
      env {
        name  = "OAUTH2_PROXY_PASS_HOST_HEADER"
        value = "false"
      }
    }
  }

  depends_on = [
    google_secret_manager_secret_version.oauth2_client_secret,
    google_secret_manager_secret_version.oauth2_cookie_secret,
  ]
}

# Public browsers must be able to reach the proxy (auth is enforced inside it).
resource "google_cloud_run_v2_service_iam_member" "oauth2_proxy_invoker" {
  name     = google_cloud_run_v2_service.oauth2_proxy.name
  location = google_cloud_run_v2_service.oauth2_proxy.location
  role     = "roles/run.invoker"
  member   = "allUsers"
}
