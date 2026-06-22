# A records for the Outline hosts in the shared app-subdomain Cloud DNS zone (the zone
# you delegated to Cloud DNS in the landing zone). Fully automated - no manual DNS. Both
# hosts point at the one LB IP; the url_map routes by host (UI vs MCP).

data "google_dns_managed_zone" "labs" {
  name = local.lz.labs_dns_zone
}

resource "google_dns_record_set" "outline" {
  name         = "${var.outline_hostname}."
  managed_zone = data.google_dns_managed_zone.labs.name
  type         = "A"
  ttl          = 300
  rrdatas      = [module.lb.ip_address]
}

resource "google_dns_record_set" "outline_mcp" {
  name         = "${var.mcp_hostname}."
  managed_zone = data.google_dns_managed_zone.labs.name
  type         = "A"
  ttl          = 300
  rrdatas      = [module.lb.ip_address]
}
