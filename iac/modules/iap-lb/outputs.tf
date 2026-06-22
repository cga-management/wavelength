output "ip_address" {
  description = "The LB's global static IP. Point each hostname's DNS A record here."
  value       = google_compute_global_address.this.address
}

output "backend_service_ids" {
  description = "Map of hostname -> backend service id (for IAM bindings like iap.httpsResourceAccessor)."
  value       = { for h, b in google_compute_backend_service.backend : h => b.id }
}

output "managed_cert_name" {
  description = "Name of the Google-managed cert (provisions once DNS resolves to the IP)."
  value       = google_compute_managed_ssl_certificate.this.name
}

output "hostnames" {
  description = "Hostnames served by this LB."
  value       = local.all_hostnames
}
