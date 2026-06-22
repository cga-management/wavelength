output "bifrost_url" {
  description = "Internal Cloud Run URL apps use to reach Bifrost. Apps call <this>/anthropic/v1/messages with their virtual key (x-api-key). Reachable only from inside the VPC."
  value       = google_cloud_run_v2_service.bifrost.uri
}

output "oauth2_proxy_url" {
  description = "Public, OIDC-gated URL for the gateway admin UI. Feed this back into var.oauth2_proxy_url for the second apply so the IdP redirect URI matches."
  value       = google_cloud_run_v2_service.oauth2_proxy.uri
}

output "gateway_ui_url" {
  description = "Public, OIDC-gated URL for the Bifrost admin UI (served at root)."
  value       = "${google_cloud_run_v2_service.oauth2_proxy.uri}/"
}

output "oidc_app_client_id" {
  description = "Client id of the dedicated GCP gateway-UI OIDC app (the auto-created Entra app, when used)."
  value       = one(azuread_application.gwui_gcp[*].client_id)
}

output "oidc_redirect_uri" {
  description = "Redirect URI to register on the gateway-UI OIDC app. Placeholder until var.oauth2_proxy_url is set."
  value       = local.gcp_redirect_uri
}
