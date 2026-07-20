# Platform secrets whose VALUES are set out-of-band (not in tofu state). The
# Anthropic key is operator-supplied: tofu creates the secret container, a human
# adds the version after apply (see iac/gcp/README.md). This mirrors the Azure
# posture where anthropic-api-key is placed into Key Vault by hand.
#
# Secrets whose values tofu DOES own (the db admin password) live in database.tf;
# the gateway-owned ones (per-app virtual keys, Bifrost encryption key) live in
# gateway-gcp/.

resource "google_secret_manager_secret" "anthropic_api_key" {
  secret_id = "anthropic-api-key"
  labels    = local.labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# Replicate provider key - operator-supplied, same posture as the Anthropic key.
resource "google_secret_manager_secret" "replicate_api_key" {
  secret_id = "replicate-api-key"
  labels    = local.labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

# Shared platform email key (Resend) - operator-supplied, same posture as above.
# One key serves BOTH consumption styles: Resend's SMTP relay authenticates with
# username "resend" and this key as the password (Outline uses this), and the same
# key drives the Resend REST API for apps that prefer an SDK. Non-secret settings
# (host, port, username, from-domain) are exposed as outputs; apps send as
# <app-slug>@<email_from_domain> (see the onboard-app skill's secrets reference).
# The sending domain is already verified in the Resend account; its DNS records
# live where that domain is managed, not in this stack's zone (see dns.tf note).
resource "google_secret_manager_secret" "email_api_key" {
  secret_id = "email-api-key"
  labels    = local.labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}
