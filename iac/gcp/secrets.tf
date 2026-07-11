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
