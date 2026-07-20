# The Wavelength admin portal - the platform's CONTROL PLANE (docs/portal.md). A
# first-class platform stack, a sibling of outline-gcp/, NOT an app onboarded through the
# onboard-app skill. It deviates from the tenant-app rules in exactly three ways: it uses
# the shared wl_admin database directly (wl_admin IS the registry it manages), it holds
# one narrowly-scoped GitHub token (actions:write on the platform repo) to dispatch
# deploys, and it holds a small set of narrowly scoped cloud grants under its OWN
# dedicated SA (per-app log panels, the Backups panel; see identity.tf). Every other
# cloud-facing action happens in the
# deploy workflow (federated CI identity) or in the out-of-process collector jobs (their
# own scoped SA, see collector.tf).
#
# Reads two pieces of platform state so nothing is duplicated or hand-passed:
#   lz   (landing zone) : network, Cloud SQL, Artifact Registry, app SA, wl_admin, DNS, telemetry dataset, cert map
#   edge (org edge)     : shared workforce identity, IAP OAuth client, Cloud Armor policies

data "terraform_remote_state" "platform" {
  backend = "gcs"
  config = {
    bucket = var.state_bucket
    prefix = var.state_prefix
  }
}

data "terraform_remote_state" "edge" {
  backend = "gcs"
  config = {
    bucket = var.state_bucket
    prefix = var.edge_state_prefix
  }
}

locals {
  lz   = data.terraform_remote_state.platform.outputs
  edge = data.terraform_remote_state.edge.outputs

  portal_image = "${local.lz.artifact_registry_repo}/portal:${var.portal_image_tag}"

  # The app subdomain the portal derives PORTAL_APP_DOMAIN from (registry hostname
  # validation). labs_dns_domain has a trailing dot; strip it.
  app_domain = trimsuffix(local.lz.labs_dns_domain, ".")
}
