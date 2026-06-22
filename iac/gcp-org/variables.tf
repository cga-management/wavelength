variable "project_id" {
  type        = string
  description = "Project that owns the project-scoped resources here (Cloud Armor policies). Matches the landing zone."
}

variable "region" {
  type        = string
  description = "Default region for the providers."
  default     = "europe-west2"
}

variable "organization_id" {
  type        = string
  description = "Numeric GCP organization id. The workforce pool is an org-level resource parented here."
}

variable "workload" {
  type        = string
  description = "Workload abbreviation in resource names, e.g. 'wl'."
  default     = "wl"
}

variable "environment" {
  type        = string
  description = "Environment component of names, e.g. 'platform'."
  default     = "platform"
}

# --- Identity provider (OIDC) ------------------------------------------------
# The auth perimeter is provider-agnostic (Workforce Identity Federation accepts any
# OIDC/SAML2 IdP). Entra/M365 ships as the worked example; for another IdP (e.g. Auth0)
# set create_entra_app_registration = false and supply the oidc_* inputs below.
variable "create_entra_app_registration" {
  type        = bool
  description = "Auto-create the Entra app registration via the azuread provider (the Entra worked example). Set false to bring your own OIDC IdP and supply oidc_issuer_uri/oidc_client_id/oidc_client_secret."
  default     = true
}

variable "entra_tenant_id" {
  type        = string
  description = "Entra (Azure AD) tenant id - only for the Entra worked example (create_entra_app_registration = true), where it derives the OIDC issuer and configures the azuread provider. Leave empty for another IdP."
  default     = ""
}

variable "oidc_issuer_uri" {
  type        = string
  description = "OIDC issuer URI for the workforce provider. Empty derives the Entra issuer from entra_tenant_id; set explicitly for another IdP, e.g. https://YOUR_TENANT.eu.auth0.com/."
  default     = ""
}

variable "oidc_client_id" {
  type        = string
  description = "OIDC client id for the workforce provider when create_entra_app_registration = false."
  default     = ""
}

variable "oidc_client_secret" {
  type        = string
  sensitive   = true
  description = "OIDC client secret for the workforce provider when create_entra_app_registration = false."
  default     = ""
}

variable "oidc_attribute_mapping" {
  type        = map(string)
  description = "Workforce-pool attribute mapping. Defaults to the Entra claim shape; override if your IdP uses different claim names."
  default = {
    "google.subject"      = "assertion.sub"
    "google.display_name" = "assertion.preferred_username"
    "google.groups"       = "assertion.groups"
  }
}

# --- IAP OAuth client two-phase wiring ---------------------------------------
variable "iap_oauth_redirect_uri" {
  type        = string
  description = "handleRedirect URI for the GCP IAP OAuth client (iap-client.tf), of the form https://iap.googleapis.com/v1/oauth/clientIds/<client_id>:handleRedirect. Empty on the FIRST apply (client_id is generated); read iap_oauth_client_id from outputs, set this, and re-apply."
  default     = ""
}

# --- Cloud Armor -------------------------------------------------------------
variable "enable_cloud_armor" {
  type        = bool
  description = "Create the shared Cloud Armor policies. Fresh GCP projects ship with a SECURITY_POLICIES quota of 0, so this defaults off; request a quota increase (IAM & Admin > Quotas, metric SECURITY_POLICIES), then set true and re-apply. While off, app LB backends get no security_policy (IAP still gates human hosts; MCP hosts are NOT yet IP-restricted)."
  default     = false
}

# --- Anthropic MCP allowlist -------------------------------------------------
variable "anthropic_cidrs" {
  type        = list(string)
  description = "Anthropic egress CIDR ranges allowed to reach MCP hosts. Empty => the anthropic-only policy denies everything (safe default until Anthropic's ranges are supplied)."
  default     = []
}

# --- Human-host rate limiting (Cloud Armor) ----------------------------------
variable "sso_rate_limit_count" {
  type        = number
  description = "Requests per interval per client IP before throttling on IAP-gated human hosts."
  default     = 600
}

variable "sso_rate_limit_interval_sec" {
  type        = number
  description = "Rate-limit interval (seconds) for the human-host throttle rule."
  default     = 60
}
