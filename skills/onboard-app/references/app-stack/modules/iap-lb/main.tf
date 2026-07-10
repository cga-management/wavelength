# Vendored copy of the platform iap-lb module (<your-platform-repo>
# iac/modules/iap-lb @ <commit>). Do NOT edit - re-sync from the platform repo
# when the module changes (see ../../README.md).

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
  # The managed cert must also cover redirect-only hosts (they terminate TLS here too).
  cert_domains   = concat(local.all_hostnames, sort(keys(var.redirect_hosts)))
  # Sanitise hostnames into resource-name-safe suffixes (dots -> dashes).
  suffix = { for h in local.all_hostnames : h => replace(h, ".", "-") }

  # Backend service names: the prefix already identifies the app, so don't repeat the
  # slug/FQDN. Add a per-host discriminator (the host's first label) ONLY when the LB
  # serves more than one host; a single-host app is just "<prefix>-be". Short, <=63.
  be_name = { for h in local.all_hostnames : h => (
    length(local.all_hostnames) > 1
    ? "${var.name_prefix}-${split(".", h)[0]}-be"
    : "${var.name_prefix}-be"
  ) }
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

  name                  = local.be_name[each.key]
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

  # The backend name is ForceNew, so a rename must create the replacement and let the
  # url_map repoint to it BEFORE the old backend is deleted - otherwise the delete fails
  # with "resourceInUseByAnotherResource".
  lifecycle {
    create_before_destroy = true
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

      # Route selected paths on this host to another route's backend (e.g. the
      # IAP-off + Anthropic-locked MCP backend), leaving the default (UI) on this
      # host's own backend. Each override -> one path_rule (its paths, one target).
      dynamic "path_rule" {
        for_each = path_matcher.value.path_overrides
        content {
          paths   = path_rule.value.paths
          service = google_compute_backend_service.backend[path_rule.value.target_hostname].id
        }
      }
    }
  }

  # Redirect-only hosts: no backend, just a 301 to the target hostname (path and
  # query preserved). Used e.g. to send the bare zone apex to the admin portal.
  dynamic "host_rule" {
    for_each = var.redirect_hosts
    content {
      hosts        = [host_rule.key]
      path_matcher = "redir-${replace(host_rule.key, ".", "-")}"
    }
  }

  dynamic "path_matcher" {
    for_each = var.redirect_hosts
    content {
      name = "redir-${replace(path_matcher.key, ".", "-")}"
      default_url_redirect {
        host_redirect          = path_matcher.value
        https_redirect         = true
        strip_query            = false
        redirect_response_code = "MOVED_PERMANENTLY_DEFAULT"
      }
    }
  }
}

# --- TLS + HTTPS proxy + forwarding rule --------------------------------------
# Two mutually exclusive TLS modes (the proxy accepts exactly ONE of certificate_map /
# ssl_certificates):
#   - var.certificate_map set  : attach the platform's Certificate Manager map (the
#     standing wildcard cert) - TLS is valid immediately, no per-host cert at all.
#   - var.certificate_map null : classic behavior, one Google-managed multi-domain
#     cert for this LB's hostnames (15-60 min PROVISIONING on first use).
resource "google_compute_managed_ssl_certificate" "this" {
  count = var.certificate_map == null ? 1 : 0

  # Managed-cert domains are immutable, so a hostname change must REPLACE the cert. The
  # name carries a hash of the domains and create_before_destroy lets the new cert be
  # created + the proxy repointed before the old (proxy-bound) cert is destroyed -
  # otherwise the same-name destroy deadlocks against the proxy and aborts the apply.
  name = "${var.name_prefix}-cert-${substr(sha1(join(",", local.cert_domains)), 0, 6)}"
  managed {
    domains = local.cert_domains
  }
  lifecycle {
    create_before_destroy = true
  }
}

# Pre-certificate_map states hold the cert unindexed; record the move so existing
# consumers (certificate_map unset) plan a clean no-op instead of a destroy/create.
moved {
  from = google_compute_managed_ssl_certificate.this
  to   = google_compute_managed_ssl_certificate.this[0]
}

resource "google_compute_target_https_proxy" "this" {
  name    = "${var.name_prefix}-https-proxy"
  url_map = google_compute_url_map.this.id

  # Exactly one of the two, keyed off var.certificate_map (null-valued attributes are
  # treated as omitted). certificate_map needs the //certificatemanager.googleapis.com/
  # resource-URL form, not the bare id.
  certificate_map  = var.certificate_map != null ? "//certificatemanager.googleapis.com/${var.certificate_map}" : null
  ssl_certificates = var.certificate_map == null ? [google_compute_managed_ssl_certificate.this[0].id] : null
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
