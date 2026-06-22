# Cloud DNS zone for the subdomain you delegate to GCP for wavelength app hostnames.
# Every app gets <app>.<your zone> (e.g. Outline lives at outline.<your zone>); the
# records are created by each app's deploy with the SAME google provider + WIF the CI
# already uses - no external DNS credential, one DNS control plane across clouds
# (Azure apps' records can live here too, pointing at their Azure ingress).
#
# Delegation (one-time, manual): add the `labs_dns_nameservers` output below as NS
# records for this subdomain at your apex (wherever the apex is managed, e.g.
# Cloudflare). After that, everything under the subdomain is managed here in tofu.
# Set var.dns_zone_name / var.dns_zone_fqdn to your own delegated subdomain.

resource "google_dns_managed_zone" "labs" {
  name        = var.dns_zone_name
  dns_name    = var.dns_zone_fqdn
  description = "Wavelength app subdomain (<app>.${trimsuffix(var.dns_zone_fqdn, ".")}); records created by app deploys."
  labels      = local.labels
  depends_on  = [google_project_service.apis]
}
