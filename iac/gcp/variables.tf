variable "project_id" {
  type        = string
  description = "Target GCP project (the subscription-equivalent). No default - supplied per deployment."
}

variable "region" {
  type        = string
  description = "GCP region, e.g. europe-west2 (London - the uksouth analogue)."
  default     = "europe-west2"
}

variable "workload" {
  type        = string
  description = "Workload abbreviation in resource names, e.g. 'wl'. Also the 'workload' label."
  default     = "wl"
}

variable "environment" {
  type        = string
  description = "Environment component of names and the 'env' label: platform, shared, prod."
  default     = "platform"
}

variable "owner" {
  type        = string
  description = "Mandatory 'owner' label value (accountable team or person)."
  default     = "wavelength-platform"
}

variable "cost_center" {
  type        = string
  description = "Mandatory 'costcenter' label value (accounting / chargeback code)."
  default     = "platform"
}

variable "expiry" {
  type        = string
  description = "'expiry' label value, feeds the lifecycle/archive job ('none' for platform infra)."
  default     = "none"
}

variable "repo" {
  type        = string
  description = "Source repo (org/name). Applied as the 'repo' label (slashes sanitised to underscores) when set."
  default     = ""
}

variable "labels" {
  type        = map(string)
  description = "Extra labels, merged over the standard owner/env/costcenter/workload/managedby/region/expiry set."
  default     = {}
}

variable "log_retention_days" {
  type        = number
  description = "Cloud Logging _Default bucket retention in days."
  default     = 30
}

variable "enable_org_policies" {
  type        = bool
  description = "Set the landing-zone org-policy guardrails (deny public Cloud SQL, restrict locations). Needs orgpolicy admin; some constraints are org-level only. Default off - this project has no organization (standalone)."
  default     = false
}

variable "allowed_locations" {
  type        = list(string)
  description = "Locations the resource-locations org policy permits (value group form, e.g. ['in:europe-west2-locations']). Empty means just the deploy region group."
  default     = []
}

# --- DNS ---------------------------------------------------------------------
# The subdomain you delegate to Cloud DNS for wavelength app hostnames. Every app
# gets <app>.<this zone> (e.g. outline.<zone>). No default: set this to YOUR own
# delegated subdomain so you never accidentally ship the example domain.
variable "dns_zone_name" {
  type        = string
  description = "Cloud DNS managed-zone resource name (lowercase, dashes), e.g. labs-example-com."
}

variable "dns_zone_fqdn" {
  type        = string
  description = "Fully-qualified DNS name for the zone, WITH trailing dot, e.g. labs.example.com."
  validation {
    condition     = endswith(var.dns_zone_fqdn, ".")
    error_message = "dns_zone_fqdn must end with a trailing dot, e.g. labs.example.com."
  }
}

# --- Network -----------------------------------------------------------------
variable "subnet_cidr" {
  type        = string
  description = "Primary range for the apps subnet (Cloud Run Direct VPC egress attaches here)."
  default     = "10.30.0.0/23"
}

variable "psa_range_address" {
  type        = string
  description = "Start address of the range reserved for Private Service Access (Cloud SQL private IP). Must not overlap subnet_cidr."
  default     = "10.30.16.0"
}

variable "psa_range_prefix" {
  type        = number
  description = "Prefix length of the Private Service Access range."
  default     = 20
}

# --- Shared database (Stage-2 tier) ------------------------------------------
variable "db_tier" {
  type        = string
  description = "Cloud SQL machine type. db-f1-micro is the cheap shared-core dev floor (no scale-to-zero exists for Cloud SQL)."
  default     = "db-f1-micro"
}

variable "pg_version" {
  type        = string
  description = "Cloud SQL PostgreSQL version, e.g. POSTGRES_16."
  default     = "POSTGRES_16"
}

variable "db_disk_size" {
  type        = number
  description = "Cloud SQL data disk size in GB."
  default     = 10
}

variable "db_admin_login" {
  type        = string
  description = "Cloud SQL administrator (Postgres) user."
  default     = "wladmin"
}

variable "email_from_domain" {
  type        = string
  description = "Verified sending domain in the email provider's account (its DNS is managed outside this zone). Convention: every app sends as <app-slug>@<this domain> (e.g. outline@...); platform@ is reserved for platform-level sends. Leave empty until the operator has verified a domain with the provider."
  default     = ""
}

# --- Usage telemetry -----------------------------------------------------------
# What identity token each app's wl.auth usage line carries (docs/usage-telemetry.md).
# This is a PLATFORM POSTURE choice, made once here and consumed by every app stack
# and the portal via the landing-zone outputs:
#   "email"  (default) - the line carries the user's normalized email. The portal can
#            then show WHO uses each app (a 30d user list), visible only to that app's
#            admins and platform admins. Reasonable default for a small platform:
#            every audience with log or dataset access can already see these emails
#            through stronger paths (raw logs, an app's own admin mode).
#   "hashed" - the line carries HMAC-SHA256(platform salt, normalized email), hex,
#            truncated. Counts only; no user lists anywhere. The stricter posture,
#            one variable flip away (redeploy apps to take effect).
variable "usage_identity_mode" {
  type        = string
  description = "Identity token in app usage-telemetry auth lines: 'email' (counts + per-app WHO list for that app's admins and platform admins) or 'hashed' (keyed pseudonymous hash, counts only)."
  default     = "email"
  validation {
    condition     = contains(["email", "hashed"], var.usage_identity_mode)
    error_message = "usage_identity_mode must be 'email' or 'hashed'."
  }
}
