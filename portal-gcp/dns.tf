# A record for the portal in the shared delegated Cloud DNS zone. Points at the LB IP;
# with the platform certificate map, TLS is valid immediately.
data "google_dns_managed_zone" "labs" {
  name = local.lz.labs_dns_zone
}

resource "google_dns_record_set" "portal" {
  name         = "${var.portal_hostname}."
  managed_zone = data.google_dns_managed_zone.labs.name
  type         = "A"
  ttl          = 300
  rrdatas      = [module.lb.ip_address]
}
