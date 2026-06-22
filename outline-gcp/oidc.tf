# Outline's native OIDC login. Outline authenticates users itself (there is no "trust
# the proxy" mode), so it owns its OWN app registration - distinct from the gateway's
# wl-gateway-ui-gcp and from the workforce-WIF/IAP client in ../iac/gcp-org/. Same IdP,
# separate registration to avoid cross-stack coupling of redirect URIs and client secrets.
#
# Users hit the IAP perimeter first (one sign-in via the workforce pool), then Outline's
# OIDC silently rides the same IdP SSO session - one interactive login.
#
# Entra ships as the worked example (create_entra_app_registration = true). For another
# OIDC IdP, set it false and supply var.oidc_client_id / var.oidc_client_secret plus the
# oidc_*_uri endpoints (see variables.tf / QUICKSTART.md).

resource "azuread_application" "outline_gcp" {
  count            = var.create_entra_app_registration ? 1 : 0
  display_name     = "wl-outline-oidc-gcp"
  sign_in_audience = "AzureADMyOrg"
  web {
    # Outline's OIDC callback path.
    redirect_uris = ["${local.outline_url}/auth/oidc.callback"]
    implicit_grant {
      id_token_issuance_enabled = true
    }
  }
}

moved {
  from = azuread_application.outline_gcp
  to   = azuread_application.outline_gcp[0]
}

resource "azuread_service_principal" "outline_gcp" {
  count     = var.create_entra_app_registration ? 1 : 0
  client_id = azuread_application.outline_gcp[0].client_id
}

moved {
  from = azuread_service_principal.outline_gcp
  to   = azuread_service_principal.outline_gcp[0]
}

resource "azuread_application_password" "outline_gcp" {
  count          = var.create_entra_app_registration ? 1 : 0
  application_id = azuread_application.outline_gcp[0].id
  display_name   = "outline-oidc-gcp"
}

moved {
  from = azuread_application_password.outline_gcp
  to   = azuread_application_password.outline_gcp[0]
}

resource "google_secret_manager_secret" "oidc_client_secret" {
  secret_id = "outline-oidc-client-secret"
  labels    = local.lz.labels
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "oidc_client_secret" {
  secret = google_secret_manager_secret.oidc_client_secret.id
  # From the auto-created Entra app, or the externally-supplied secret for another IdP.
  secret_data = var.create_entra_app_registration ? one(azuread_application_password.outline_gcp[*].value) : var.oidc_client_secret
}
