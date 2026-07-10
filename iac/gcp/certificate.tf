# Platform-wide TLS: one Google-managed WILDCARD certificate via Certificate Manager
# (roadmap wave-1 item 3). Classic LB managed certs cannot do wildcards, so every new
# app hostname paid a 15-60 min PROVISIONING wait on first deploy. Certificate Manager
# can: a wildcard for *.<zone apex> plus the apex itself, validated ONCE by a standing
# DNS authorization CNAME in our own Cloud DNS zone, auto-renewing forever. App LBs
# attach the certificate MAP (see the iap-lb module's certificate_map input) and have
# valid TLS the moment their forwarding rule exists.

locals {
  # The delegated zone apex, e.g. "labs.example.com" (zone fqdn without trailing dot).
  dns_apex = trimsuffix(var.dns_zone_fqdn, ".")
}

# Standing DNS authorization for the apex. One authorization on the apex domain also
# validates the single-level wildcard (*.<apex>) - Google checks the same CNAME.
resource "google_certificate_manager_dns_authorization" "apex" {
  name        = "dnsauth-${var.workload}-${var.environment}"
  description = "Standing DNS authorization for ${local.dns_apex}; validates the platform wildcard certificate."
  domain      = local.dns_apex
  labels      = local.labels
  depends_on  = [google_project_service.apis]
}

# The authorization's validation CNAME, kept permanently in our own zone so issuance
# AND every future renewal validate without any further action.
resource "google_dns_record_set" "cert_validation" {
  name         = google_certificate_manager_dns_authorization.apex.dns_resource_record[0].name
  type         = google_certificate_manager_dns_authorization.apex.dns_resource_record[0].type
  ttl          = 300
  managed_zone = google_dns_managed_zone.labs.name
  rrdatas      = [google_certificate_manager_dns_authorization.apex.dns_resource_record[0].data]
}

# The Google-managed wildcard certificate: covers the apex and every single-level
# subdomain (all current app hostnames qualify).
resource "google_certificate_manager_certificate" "wildcard" {
  name        = "cert-${var.workload}-wildcard"
  description = "Platform wildcard certificate for ${local.dns_apex} and *.${local.dns_apex}."
  labels      = local.labels

  managed {
    domains            = [local.dns_apex, "*.${local.dns_apex}"]
    dns_authorizations = [google_certificate_manager_dns_authorization.apex.id]
  }
}

# The certificate map an HTTPS proxy attaches (a proxy takes a map, not a bare
# Certificate Manager cert). One entry per served name pattern, both pointing at the
# same wildcard cert.
resource "google_certificate_manager_certificate_map" "wildcard" {
  name        = "certmap-${var.workload}-${var.environment}"
  description = "Platform certificate map: serves the wildcard cert for ${local.dns_apex} and *.${local.dns_apex}."
  labels      = local.labels
  depends_on  = [google_project_service.apis]
}

resource "google_certificate_manager_certificate_map_entry" "wildcard" {
  name         = "wildcard"
  map          = google_certificate_manager_certificate_map.wildcard.name
  certificates = [google_certificate_manager_certificate.wildcard.id]
  hostname     = "*.${local.dns_apex}"
  labels       = local.labels
}

resource "google_certificate_manager_certificate_map_entry" "apex" {
  name         = "apex"
  map          = google_certificate_manager_certificate_map.wildcard.name
  certificates = [google_certificate_manager_certificate.wildcard.id]
  hostname     = local.dns_apex
  labels       = local.labels
}
