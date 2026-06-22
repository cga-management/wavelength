# Platform VPC. The spine of the three-ring edge doctrine on GCP:
#   - apps subnet           : Cloud Run services attach here via Direct VPC egress
#   - private services access: Cloud SQL gets a private IP from a peered range, so
#                              the DB has no public endpoint (Ring 3 / deny-public-DB)
#   - Cloud NAT             : egress to the internet for the public-egress service
#                            (oauth2-proxy reaches Entra over ALL_TRAFFIC egress)
#
# Cloud Run "internal ingress" (Ring 2, Bifrost) is admitted only for traffic that
# originates inside this VPC, so the public oauth2-proxy (Ring 1) reaches Bifrost by
# routing its request through the VPC (Direct VPC egress = ALL_TRAFFIC). See
# gateway-gcp/oauth2proxy.tf.

resource "google_compute_network" "platform" {
  name                    = "vpc-${var.workload}-${var.environment}"
  auto_create_subnetworks = false
  depends_on              = [google_project_service.apis]
}

# Apps subnet. private_ip_google_access lets Cloud Run reach Google APIs (Secret
# Manager, Artifact Registry) privately when egress is routed through the VPC.
resource "google_compute_subnetwork" "apps" {
  name                     = "snet-${var.workload}-apps"
  region                   = var.region
  network                  = google_compute_network.platform.id
  ip_cidr_range            = var.subnet_cidr
  private_ip_google_access = true
}

# Private Service Access: reserve a range and peer servicenetworking so Cloud SQL
# can be given a private IP from it (the delegated-subnet + private-DNS analogue).
resource "google_compute_global_address" "psa" {
  name          = "psa-${var.workload}-${var.environment}"
  purpose       = "VPC_PEERING"
  address_type  = "INTERNAL"
  address       = var.psa_range_address
  prefix_length = var.psa_range_prefix
  network       = google_compute_network.platform.id
}

resource "google_service_networking_connection" "psa" {
  network                 = google_compute_network.platform.id
  service                 = "servicenetworking.googleapis.com"
  reserved_peering_ranges = [google_compute_global_address.psa.name]
}

# Cloud NAT so VPC-routed egress can reach the public internet. Needed by the
# public-egress service (oauth2-proxy -> login.microsoftonline.com). Bifrost uses
# PRIVATE_RANGES_ONLY egress, so its Anthropic calls take Google's default path and
# do not depend on this.
resource "google_compute_router" "platform" {
  name    = "rtr-${var.workload}-${var.environment}"
  region  = var.region
  network = google_compute_network.platform.id
}

resource "google_compute_router_nat" "platform" {
  name                               = "nat-${var.workload}-${var.environment}"
  router                             = google_compute_router.platform.name
  region                             = var.region
  nat_ip_allocate_option             = "AUTO_ONLY"
  source_subnetwork_ip_ranges_to_nat = "ALL_SUBNETWORKS_ALL_IP_RANGES"
}
