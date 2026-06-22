# Workforce Identity Federation: your OIDC IdP as the human IdP for GCP. This is what
# lets IAP authenticate your workforce users (who have no Google identities) at the
# perimeter in front of every wavelength app.
#
# IdP-AGNOSTIC: GCP Workforce Identity Federation accepts any OIDC (or SAML2) provider.
# This stack ships ENTRA / Microsoft 365 as the worked example - it auto-creates the
# Entra app registration via the azuread provider. To use a different OIDC IdP (e.g.
# Auth0): set create_entra_app_registration = false and supply oidc_issuer_uri /
# oidc_client_id / oidc_client_secret (and oidc_attribute_mapping if your claim names
# differ). See the auth examples in QUICKSTART.md.
#
# Org-level (parent = the organization), so this stack is run by the day-to-day admin
# holding roles/iam.workforcePoolAdmin - not by the project-scoped CI SA.
#
# >>> SPIKE / VALIDATE AT APPLY <<<
# The IdP app's redirect URIs and the IAP handleRedirect URI must be confirmed against
# the live IdP. The workforce sign-in callback below is deterministic from the
# pool/provider ids; the IAP handleRedirect URI embeds the generated client id, so it is
# added two-phase (see iap_oauth_redirect_uri). Confirm web_sso response/claims behaviour
# against current Google docs before relying on this in production.

locals {
  workforce_pool_id     = "${var.workload}-entra"
  workforce_provider_id = "entra-oidc"

  # Deterministic workforce sign-in callback (no dependency on the IdP client id).
  # Host confirmed against the live AADSTS50011 error: auth.cloud.google (NOT the older
  # auth.gcp.secure.goog that some docs/examples still show).
  workforce_callback = "https://auth.cloud.google/signin-callback/locations/global/workforcePools/${local.workforce_pool_id}/providers/${local.workforce_provider_id}"

  # OIDC issuer: an explicit override wins; otherwise derive the Entra issuer from the
  # tenant (the Entra worked example).
  entra_issuer = var.entra_tenant_id != "" ? "https://login.microsoftonline.com/${var.entra_tenant_id}/v2.0" : ""
  oidc_issuer  = var.oidc_issuer_uri != "" ? var.oidc_issuer_uri : local.entra_issuer

  # Client credentials: from the auto-created Entra app, or supplied directly for another
  # IdP. one(...[*]...) is index-safe whichever branch the conditional discards.
  oidc_client_id     = var.create_entra_app_registration ? one(azuread_application.workforce_iap[*].client_id) : var.oidc_client_id
  oidc_client_secret = var.create_entra_app_registration ? one(azuread_application_password.workforce_iap[*].value) : var.oidc_client_secret
}

# --- The Entra app the workforce provider + IAP sign in with (EXAMPLE IdP) -----
# Created only when create_entra_app_registration = true. For another OIDC IdP, set it
# false, create the equivalent app in your IdP, and pass oidc_client_id/oidc_client_secret.
# One registration used both as the workforce-pool OIDC client and as the IAP OAuth2
# client (the docs note these are "the same WIF-infrastructure client", distinct from
# the Google-identity custom-OAuth client).
resource "azuread_application" "workforce_iap" {
  count            = var.create_entra_app_registration ? 1 : 0
  display_name     = "wl-workforce-iap-gcp"
  sign_in_audience = "AzureADMyOrg"
  web {
    # ONLY the workforce sign-in callback. This Entra app is the workforce PROVIDER's
    # IdP client (Google->Entra). The IAP client is a separate GCP oauth client
    # (iap-client.tf) - do not add the iap.googleapis.com handleRedirect here.
    redirect_uris = [local.workforce_callback]
    implicit_grant {
      id_token_issuance_enabled = true
    }
  }
}

moved {
  from = azuread_application.workforce_iap
  to   = azuread_application.workforce_iap[0]
}

resource "azuread_service_principal" "workforce_iap" {
  count     = var.create_entra_app_registration ? 1 : 0
  client_id = azuread_application.workforce_iap[0].client_id
}

moved {
  from = azuread_service_principal.workforce_iap
  to   = azuread_service_principal.workforce_iap[0]
}

resource "azuread_application_password" "workforce_iap" {
  count          = var.create_entra_app_registration ? 1 : 0
  application_id = azuread_application.workforce_iap[0].id
  display_name   = "workforce-iap-gcp"
}

moved {
  from = azuread_application_password.workforce_iap
  to   = azuread_application_password.workforce_iap[0]
}

# --- Workforce pool + OIDC provider ------------------------------------------
resource "google_iam_workforce_pool" "this" {
  workforce_pool_id = local.workforce_pool_id
  parent            = "organizations/${var.organization_id}"
  location          = "global"
  display_name      = "Wavelength workforce"
  description       = "Workforce users federated into GCP for IAP-gated access to wavelength apps."
}

resource "google_iam_workforce_pool_provider" "entra" {
  workforce_pool_id = google_iam_workforce_pool.this.workforce_pool_id
  location          = google_iam_workforce_pool.this.location
  provider_id       = local.workforce_provider_id
  display_name      = "Workforce OIDC"

  attribute_mapping = var.oidc_attribute_mapping

  oidc {
    issuer_uri = local.oidc_issuer
    client_id  = local.oidc_client_id
    client_secret {
      value {
        plain_text = local.oidc_client_secret
      }
    }
    web_sso_config {
      response_type             = "CODE"
      assertion_claims_behavior = "MERGE_USER_INFO_OVER_ID_TOKEN_CLAIMS"
    }
  }
}
# (The IAP client secret moved to iap-client.tf - it is the GCP oauth client's
# credential, not the IdP app password.)
