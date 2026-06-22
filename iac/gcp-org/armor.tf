# Shared Cloud Armor policies, attached by app LB backends (via the iap-lb module).
# Two postures every app reuses:
#   - sso-default   : default-allow with a per-IP rate-limit/throttle, for IAP-gated
#                     human hosts (IAP is the real gate; this just blunts fuzzing/floods).
#   - anthropic-only: default-DENY, allow only Anthropic egress CIDRs, for MCP hosts
#                     that bypass IAP and authenticate with an API token instead.

# --- Human hosts: allow, but throttle abusive IPs ----------------------------
resource "google_compute_security_policy" "sso_default" {
  count       = var.enable_cloud_armor ? 1 : 0
  name        = "${var.workload}-armor-sso-default"
  description = "IAP-gated human hosts: default allow with per-IP rate limiting."

  rule {
    action   = "throttle"
    priority = 1000
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    rate_limit_options {
      conform_action = "allow"
      exceed_action  = "deny(429)"
      enforce_on_key = "IP"
      rate_limit_threshold {
        count        = var.sso_rate_limit_count
        interval_sec = var.sso_rate_limit_interval_sec
      }
    }
    description = "Per-IP throttle to blunt fuzzing/floods before IAP."
  }

  rule {
    action   = "allow"
    priority = 2147483647 # default rule
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Default allow (IAP enforces identity)."
  }
}

# --- MCP hosts: deny all except Anthropic egress ranges ----------------------
resource "google_compute_security_policy" "anthropic_only" {
  count       = var.enable_cloud_armor ? 1 : 0
  name        = "${var.workload}-armor-anthropic-only"
  description = "MCP hosts: default deny, allow only Anthropic egress CIDRs."

  # Allow rule only materialises when CIDRs are supplied; otherwise the policy is
  # pure default-deny (safe until Anthropic's ranges are known).
  dynamic "rule" {
    for_each = length(var.anthropic_cidrs) > 0 ? [1] : []
    content {
      action   = "allow"
      priority = 1000
      match {
        versioned_expr = "SRC_IPS_V1"
        config {
          src_ip_ranges = var.anthropic_cidrs
        }
      }
      description = "Allow Anthropic egress ranges to reach MCP."
    }
  }

  rule {
    action   = "deny(403)"
    priority = 2147483647 # default rule
    match {
      versioned_expr = "SRC_IPS_V1"
      config {
        src_ip_ranges = ["*"]
      }
    }
    description = "Default deny everything not explicitly allowed above."
  }
}
