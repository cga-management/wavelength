# A record for myapp in the shared delegated Cloud DNS zone. Points at the LB IP; the
# Google-managed cert (created by the iap-lb module) provisions once this resolves.
data "google_dns_managed_zone" "labs" {
  name = local.lz.labs_dns_zone
}

resource "google_dns_record_set" "app" {
  name         = "${var.app_hostname}."
  managed_zone = data.google_dns_managed_zone.labs.name
  type         = "A"
  ttl          = 300
  rrdatas      = [module.lb.ip_address]
}
