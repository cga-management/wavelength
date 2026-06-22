# Reusable external HTTPS load balancer for a Cloud Run app behind the shared IAP
# perimeter. One global IP + one managed cert (multi-domain) + one URL map serve N
# hostnames; each hostname gets its own backend service so IAP and Cloud Armor can
# differ per host while all backends fan in to the SAME Cloud Run service via a single
# serverless NEG.
#
# This is the plumbing every wavelength app reuses. The shared IDENTITY (workforce
# pool + IAP OAuth client) and the Cloud Armor POLICIES live once in ../../gcp-org/;
# this module just wires them onto an app's LB.
#
# IAP note: enable IAP on the LB backend, NEVER also on the Cloud Run service (Google
# explicitly warns against double-enabling). The fronted service must therefore be
# INGRESS_TRAFFIC_INTERNAL_LOAD_BALANCING with no public invoker.

terraform {
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = ">= 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
      version = ">= 6.0"
    }
  }
}

locals {
  routes_by_host = { for r in var.routes : r.hostname => r }
  iap_hosts      = { for r in var.routes : r.hostname => r if r.enable_iap }
  all_hostnames  = [for r in var.routes : r.hostname]
  # Sanitise hostnames into resource-name-safe suffixes (dots -> dashes).
  suffix = { for h in local.all_hostnames : h => replace(h, ".", "-") }
}

# --- One serverless NEG -> the Cloud Run service -----------------------------
resource "google_compute_region_network_endpoint_group" "neg" {
  name                  = "${var.name_prefix}-neg"
  region                = var.region
  network_endpoint_type = "SERVERLESS"
  cloud_run {
    service = var.cloud_run_service
  }
}

# --- A backend service per hostname (so IAP / Cloud Armor can differ) --------
resource "google_compute_backend_service" "backend" {
  for_each = local.routes_by_host

  name                  = "${var.name_prefix}-${local.suffix[each.key]}-be"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  protocol              = "HTTPS"
  security_policy       = each.value.security_policy

  backend {
    group = google_compute_region_network_endpoint_group.neg.id
  }

  # Enable IAP at the backend for human routes. The workforce-identity OAuth config
  # is supplied separately by google_iap_settings below; the client id/secret here let
  # the backend's IAP enforcement bind to that client.
  dynamic "iap" {
    for_each = each.value.enable_iap ? [1] : []
    content {
      enabled              = true
      oauth2_client_id     = var.iap_oauth2_client_id
      oauth2_client_secret = var.iap_oauth2_client_secret
    }
  }
}

# --- Workforce-identity IAP settings on the IAP-enabled backends -------------
# Names the backend service as projects/<p>/iap_web/compute/services/<service_id> and
# points IAP at the shared workforce pool. (google-beta carries this resource.)
resource "google_iap_settings" "workforce" {
  for_each = local.iap_hosts
  provider = google-beta

  name = "projects/${var.project_id}/iap_web/compute/services/${google_compute_backend_service.backend[each.key].generated_id}"

  access_settings {
    identity_sources = ["WORKFORCE_IDENTITY_FEDERATION"]
    workforce_identity_settings {
      workforce_pools = [var.workforce_pool]
      oauth2 {
        client_id     = var.iap_oauth2_client_id
        client_secret = var.iap_oauth2_client_secret
      }
    }
  }
}

# --- Authorize workforce users on the IAP-enabled backends -------------------
# Flatten (iap host x member) into a keyed map for for_each.
locals {
  iap_member_bindings = merge([
    for host in keys(local.iap_hosts) : {
      for m in var.iap_members : "${host}::${m}" => { host = host, member = m }
    }
  ]...)
}

resource "google_iap_web_backend_service_iam_member" "members" {
  for_each = local.iap_member_bindings

  web_backend_service = google_compute_backend_service.backend[each.value.host].name
  role                = "roles/iap.httpsResourceAccessor"
  member              = each.value.member
}

# --- Authorize IAP -> Cloud Run -----------------------------------------------
# After IAP authenticates the user, the LB invokes Cloud Run AS the IAP service agent.
# Grant it run.invoker so the post-auth call is authorized. This is the org-compatible
# path: domain-restricted sharing blocks the `allUsers` invoker the external ALB would
# otherwise need. (Non-IAP routes - e.g. the MCP host - still need allUsers or a scoped
# org-policy exception; see the module README / STANDUP.)
data "google_project" "this" {
  project_id = var.project_id
}

resource "google_cloud_run_v2_service_iam_member" "iap_invoker" {
  count    = length(local.iap_hosts) > 0 ? 1 : 0
  project  = var.project_id
  location = var.region
  name     = var.cloud_run_service
  role     = "roles/run.invoker"
  member   = "serviceAccount:service-${data.google_project.this.number}@gcp-sa-iap.iam.gserviceaccount.com"
}

# --- URL map: route each hostname to its backend -----------------------------
resource "google_compute_url_map" "this" {
  name = "${var.name_prefix}-urlmap"
  # Default to the first route's backend (a deterministic, safe fallback).
  default_service = google_compute_backend_service.backend[local.all_hostnames[0]].id

  dynamic "host_rule" {
    for_each = local.routes_by_host
    content {
      hosts        = [host_rule.key]
      path_matcher = local.suffix[host_rule.key]
    }
  }

  dynamic "path_matcher" {
    for_each = local.routes_by_host
    content {
      name            = local.suffix[path_matcher.key]
      default_service = google_compute_backend_service.backend[path_matcher.key].id
    }
  }
}

# --- Google-managed multi-domain cert + HTTPS proxy + forwarding rule ---------
resource "google_compute_managed_ssl_certificate" "this" {
  # Managed-cert domains are immutable, so a hostname change must REPLACE the cert. The
  # name carries a hash of the domains and create_before_destroy lets the new cert be
  # created + the proxy repointed before the old (proxy-bound) cert is destroyed -
  # otherwise the same-name destroy deadlocks against the proxy and aborts the apply.
  name = "${var.name_prefix}-cert-${substr(sha1(join(",", local.all_hostnames)), 0, 6)}"
  managed {
    domains = local.all_hostnames
  }
  lifecycle {
    create_before_destroy = true
  }
}

resource "google_compute_target_https_proxy" "this" {
  name             = "${var.name_prefix}-https-proxy"
  url_map          = google_compute_url_map.this.id
  ssl_certificates = [google_compute_managed_ssl_certificate.this.id]
}

resource "google_compute_global_address" "this" {
  name = "${var.name_prefix}-ip"
}

resource "google_compute_global_forwarding_rule" "this" {
  name                  = "${var.name_prefix}-fr"
  load_balancing_scheme = "EXTERNAL_MANAGED"
  target                = google_compute_target_https_proxy.this.id
  port_range            = "443"
  ip_address            = google_compute_global_address.this.id
}
