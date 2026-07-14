output "lb_ip_address" {
  description = "Global LB IP. The DNS A record already points here (dns.tf)."
  value       = module.lb.ip_address
}

output "portal_hostname" {
  description = "The portal's public (IAP-gated) hostname."
  value       = var.portal_hostname
}

output "computed_iap_audience" {
  description = "The IAP JWT audience for the portal backend (the iap-lb module builds it from the numeric backend id). Two-phase: after the first apply, set var.iap_audience to this value and re-apply so the portal verifies IAP tokens."
  value       = module.lb.backend_service_audiences[var.portal_hostname]
}

output "portal_service_uri" {
  description = "Internal Cloud Run URI (reachable only via the LB; for debugging)."
  value       = google_cloud_run_v2_service.portal.uri
}

output "portal_service_account" {
  description = "Dedicated runtime SA the portal runs as (NOT the shared app SA). Holds the one read-only cloud capability - Cloud Logging read - plus cloudsql.client, artifactregistry.reader and secretAccessor on the two portal secrets."
  value       = google_service_account.portal.email
}

output "collector_service_account" {
  description = "Dedicated, scoped SA the collector job runs as (NOT the shared app SA)."
  value       = google_service_account.collector.email
}

output "collector_job" {
  description = "Cloud Run Job name for the telemetry collectors."
  value       = google_cloud_run_v2_job.collector.name
}
