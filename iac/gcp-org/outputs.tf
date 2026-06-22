# Consumed by every app stack that sits behind the shared perimeter (e.g. outline-gcp).

output "workforce_pool_name" {
  description = "Full workforce pool resource name for IAP settings (locations/global/workforcePools/<id>)."
  value       = "locations/global/workforcePools/${google_iam_workforce_pool.this.workforce_pool_id}"
}

output "workforce_provider_name" {
  description = "Full workforce pool provider resource name."
  value       = "locations/global/workforcePools/${google_iam_workforce_pool.this.workforce_pool_id}/providers/${google_iam_workforce_pool_provider.entra.provider_id}"
}

output "oidc_app_client_id" {
  description = "Client id of the workforce PROVIDER's IdP client (the auto-created Entra app, when used) - the Google->IdP client only. NOT the IAP client. Null when bringing your own IdP."
  value       = one(azuread_application.workforce_iap[*].client_id)
}

output "iap_oauth_client_id" {
  description = "Generated client_id of the GCP IAP OAuth client (iap-client.tf). This is the IAP client app LB stacks use - build the handleRedirect URI from it for the 2nd apply."
  value       = google_iam_oauth_client.iap.client_id
}

output "iap_client_secret_id" {
  description = "Secret Manager secret id holding the GCP IAP OAuth client credential secret. App LB stacks read this for their IAP backend + settings."
  value       = google_secret_manager_secret.iap_client_secret.secret_id
}

output "armor_sso_default_id" {
  description = "Self-link of the human-host (IAP-gated) Cloud Armor policy, or null when Cloud Armor is disabled."
  value       = var.enable_cloud_armor ? google_compute_security_policy.sso_default[0].id : null
}

output "armor_anthropic_only_id" {
  description = "Self-link of the MCP (Anthropic-IP-locked) Cloud Armor policy, or null when Cloud Armor is disabled."
  value       = var.enable_cloud_armor ? google_compute_security_policy.anthropic_only[0].id : null
}
