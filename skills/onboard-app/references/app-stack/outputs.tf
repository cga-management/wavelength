output "lb_ip_address" {
  description = "Global LB IP. The DNS A record already points here (dns.tf)."
  value       = module.lb.ip_address
}

output "app_hostname" {
  value = var.app_hostname
}

output "computed_iap_audience" {
  description = "The IAP JWT audience for this app's backend (the module builds it correctly from the numeric backend id). Two-phase: after the first apply, set var.iap_audience to this value and re-apply."
  value       = module.lb.backend_service_audiences[var.app_hostname]
}

output "service_uri" {
  description = "Internal Cloud Run URI (reachable only via the LB; for debugging)."
  value       = google_cloud_run_v2_service.app.uri
}
