variable "project_id" {
  type        = string
  description = "Target GCP project (must match the landing zone)."
}

variable "region" {
  type        = string
  description = "GCP region (must match the landing zone)."
  default     = "europe-west2"
}

variable "workload" {
  type        = string
  description = "Workload abbreviation (must match the landing zone, e.g. 'wl')."
  default     = "wl"
}

variable "environment" {
  type        = string
  description = "Environment component (must match the landing zone, e.g. 'platform')."
  default     = "platform"
}

# --- Remote state: landing zone (network, Cloud SQL, AR, app SA, secrets) ----
variable "state_bucket" {
  type        = string
  description = "GCS bucket holding the tofu state (shared across stacks)."
}

variable "state_prefix" {
  type        = string
  description = "Prefix of the landing-zone state in the bucket."
  default     = "gcp-landing-zone"
}

# --- Remote state: org edge (workforce WIF + IAP + Cloud Armor) ---------------
# The shared perimeter every wavelength app sits behind, built once in ../iac/gcp-org/.
variable "edge_state_prefix" {
  type        = string
  description = "Prefix of the org-edge (IAP/WIF/Cloud Armor) state in the bucket."
  default     = "gcp-org-edge"
}

# --- Identity provider (OIDC) ------------------------------------------------
# Outline authenticates users itself via OIDC. Entra/M365 ships as the worked example
# (auto-creates the Entra app registration). For another OIDC IdP (e.g. Auth0), set
# create_entra_app_registration = false and supply oidc_client_id/oidc_client_secret and
# the oidc_*_uri endpoints.
variable "create_entra_app_registration" {
  type        = bool
  description = "Auto-create Outline's Entra app registration via the azuread provider (the Entra worked example). Set false to bring your own OIDC IdP and supply the oidc_* inputs."
  default     = true
}

variable "entra_tenant_id" {
  type        = string
  description = "Entra (Azure AD) tenant id - only for the Entra worked example; derives the OIDC endpoints and configures the azuread provider. Leave empty for another IdP."
  default     = ""
}

variable "oidc_client_id" {
  type        = string
  description = "OIDC client id for Outline when create_entra_app_registration = false."
  default     = ""
}

variable "oidc_client_secret" {
  type        = string
  sensitive   = true
  description = "OIDC client secret for Outline when create_entra_app_registration = false."
  default     = ""
}

variable "oidc_auth_uri" {
  type        = string
  description = "OIDC authorize endpoint. Empty derives the Entra endpoint from entra_tenant_id."
  default     = ""
}

variable "oidc_token_uri" {
  type        = string
  description = "OIDC token endpoint. Empty derives the Entra endpoint from entra_tenant_id."
  default     = ""
}

variable "oidc_userinfo_uri" {
  type        = string
  description = "OIDC userinfo endpoint. Empty uses the Entra/Microsoft Graph endpoint."
  default     = ""
}

variable "oidc_username_claim" {
  type        = string
  description = "Claim Outline uses as the username. Entra v2 reliably emits preferred_username (not always email)."
  default     = "preferred_username"
}

variable "oidc_display_name" {
  type        = string
  description = "Label shown on Outline's SSO button, e.g. 'Microsoft' or 'Auth0'."
  default     = "Microsoft"
}

variable "oidc_scopes" {
  type        = string
  description = "OIDC scopes Outline requests."
  default     = "openid profile email"
}

# --- Images (mirrored into the platform Artifact Registry; see README) --------
variable "outline_image_tag" {
  type        = string
  description = "Tag of the mirrored outline image in Artifact Registry (e.g. '0.82.0')."
  default     = "latest"
}

variable "redis_image_tag" {
  type        = string
  description = "Tag of the mirrored redis image in Artifact Registry (e.g. '7-alpine')."
  default     = "7-alpine"
}

# --- Hostnames ---------------------------------------------------------------
# No defaults: set these to hosts under YOUR delegated subdomain (see the landing
# zone's dns_zone_fqdn) so you never accidentally ship the example domain.
variable "outline_hostname" {
  type        = string
  description = "Public hostname for human access (IAP-gated), e.g. outline.labs.example.com."
}

variable "mcp_hostname" {
  type        = string
  description = "Public hostname for Anthropic MCP access (IAP-bypassed, Cloud Armor IP-locked), e.g. outline-mcp.labs.example.com."
}

# --- Sizing ------------------------------------------------------------------
variable "outline_min_instances" {
  type        = number
  description = "Min Cloud Run instances. The Redis sidecar is per-instance and non-shared, so keep this at 1 for the test (see README)."
  default     = 1
}

variable "outline_max_instances" {
  type        = number
  description = "Max Cloud Run instances. Keep at 1 while Redis is a sidecar (multi-instance needs Memorystore for shared pub-sub)."
  default     = 1
}

variable "outline_cpu" {
  type        = string
  description = "vCPU for the Outline container."
  default     = "1"
}

variable "outline_memory" {
  type        = string
  description = "Memory for the Outline container."
  default     = "1Gi"
}
