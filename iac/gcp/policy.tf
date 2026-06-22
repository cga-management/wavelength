# Landing-zone guardrails as GCP Organization Policy, attached at the PROJECT (the
# Azure-Policy-at-resource-group analogue). Gated behind var.enable_org_policies and
# OFF by default: this project is standalone (no organization), some constraints are
# settable only at org/folder scope, and the constraints below need
# roles/orgpolicy.policyAdmin on the caller.
#
# GCP has no native "require a label" constraint (the Azure require-tag policy has no
# equivalent); label hygiene is enforced by convention (every resource carries
# local.labels) and can be checked in the conformance gate. [build catch-up]

# Deny public IPs on Cloud SQL - the deny-public-DB guardrail.
resource "google_org_policy_policy" "sql_no_public_ip" {
  count  = var.enable_org_policies ? 1 : 0
  name   = "projects/${var.project_id}/policies/sql.restrictPublicIp"
  parent = "projects/${var.project_id}"
  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

# Disable service-account key creation - aligns with the no-static-credentials
# doctrine (CI uses Workload Identity Federation; apps run as a service account).
resource "google_org_policy_policy" "no_sa_keys" {
  count  = var.enable_org_policies ? 1 : 0
  name   = "projects/${var.project_id}/policies/iam.disableServiceAccountKeyCreation"
  parent = "projects/${var.project_id}"
  spec {
    rules {
      enforce = "TRUE"
    }
  }
}

# Restrict the locations resources may be created in (the Allowed-locations analogue).
# Value-group form, e.g. "in:europe-west2-locations"; falls back to the deploy region's group.
resource "google_org_policy_policy" "resource_locations" {
  count  = var.enable_org_policies ? 1 : 0
  name   = "projects/${var.project_id}/policies/gcp.resourceLocations"
  parent = "projects/${var.project_id}"
  spec {
    rules {
      values {
        allowed_values = length(var.allowed_locations) > 0 ? var.allowed_locations : ["in:${var.region}-locations"]
      }
    }
  }
}
