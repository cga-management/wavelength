output "lb_ip_address" {
  description = "Global LB IP. Create DNS A records for both hostnames pointing here (see dns note in README)."
  value       = module.lb.ip_address
}

output "outline_hostname" {
  description = "Human (IAP-gated) hostname for Outline."
  value       = var.outline_hostname
}

output "mcp_hostname" {
  description = "Anthropic MCP (IP-locked, IAP-bypassed) hostname for Outline."
  value       = var.mcp_hostname
}

output "outline_service_uri" {
  description = "Internal Cloud Run URI (reachable only via the LB; for debugging)."
  value       = google_cloud_run_v2_service.outline.uri
}

output "uploads_bucket" {
  description = "GCS bucket backing Outline file uploads (S3-compatible)."
  value       = google_storage_bucket.outline.name
}

output "oidc_redirect_uri" {
  description = "Redirect URI to register on Outline's own OIDC app in your IdP."
  value       = "${local.outline_url}/auth/oidc.callback"
}
