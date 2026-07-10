# Vendored copy of the platform iap-lb module (<your-platform-repo>
# iac/modules/iap-lb @ <commit>). Do NOT edit - re-sync from the platform repo
# when the module changes (see ../../README.md).

output "ip_address" {
  description = "The LB's global static IP. Point each hostname's DNS A record here."
  value       = google_compute_global_address.this.address
}

output "backend_service_ids" {
  description = "Map of hostname -> backend service resource id (for IAM bindings like iap.httpsResourceAccessor)."
  value       = { for h, b in google_compute_backend_service.backend : h => b.id }
}

output "backend_service_audiences" {
  description = "Map of hostname -> the IAP JWT audience for that backend, i.e. /projects/<project-number>/global/backendServices/<numeric backend id>. Feed into the app as IAP_AUDIENCE (two-phase; known after the backend exists)."
  value = { for h, b in google_compute_backend_service.backend : h =>
    "/projects/${data.google_project.this.number}/global/backendServices/${b.generated_id}"
  }
}

output "managed_cert_name" {
  description = "Name of the per-LB Google-managed cert (provisions once DNS resolves to the IP). Null when var.certificate_map is set - TLS then comes from the platform certificate map instead."
  value       = one(google_compute_managed_ssl_certificate.this[*].name)
}

output "hostnames" {
  description = "Hostnames served by this LB."
  value       = local.all_hostnames
}
