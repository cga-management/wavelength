# The IAP OAuth client for Workforce Identity Federation.
#
# CRITICAL LESSON (cost us a live 401 "invalid_client"): the client that
# auth.cloud.google validates for IAP+WIF is a GCP `iam oauth-clients` resource, NOT the
# Entra app. The Entra app (workforce.tf) is ONLY the workforce provider's client, used
# for the Google->Entra hop. Reusing the Entra app as the IAP client fails.
#
# client_id is GENERATED, and the IAP handleRedirect URI embeds it, so it is two-phase:
# leave var.iap_oauth_redirect_uri empty on the first apply, read iap_oauth_client_id
# from outputs, then set it to
#   https://iap.googleapis.com/v1/oauth/clientIds/<client_id>:handleRedirect
# and re-apply.

resource "google_iam_oauth_client" "iap" {
  provider            = google-beta
  oauth_client_id     = "wl-iap"
  location            = "global"
  project             = var.project_id
  display_name        = "wl-iap-workforce"
  client_type         = "CONFIDENTIAL_CLIENT"
  allowed_grant_types = ["AUTHORIZATION_CODE_GRANT"]
  allowed_scopes      = ["https://www.googleapis.com/auth/cloud-platform"]
  allowed_redirect_uris = [
    var.iap_oauth_redirect_uri != "" ? var.iap_oauth_redirect_uri : "https://placeholder.example.com/cb"
  ]
}

resource "google_iam_oauth_client_credential" "iap" {
  provider                   = google-beta
  oauth_client_credential_id = "wl-iap-tf"
  oauthclient                = google_iam_oauth_client.iap.oauth_client_id
  location                   = "global"
  project                    = var.project_id
  display_name               = "iap-tf"
}

# The IAP client secret app LB stacks consume (their iap-lb backend + iap_settings).
resource "google_secret_manager_secret" "iap_client_secret" {
  secret_id = "iap-oauth-client-secret"
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "iap_client_secret" {
  secret      = google_secret_manager_secret.iap_client_secret.id
  secret_data = google_iam_oauth_client_credential.iap.client_secret
}
