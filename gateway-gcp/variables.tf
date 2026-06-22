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

# Landing-zone remote state location (the GCS bucket bootstrap.sh made).
variable "state_bucket" {
  type        = string
  description = "GCS bucket holding the landing-zone tofu state."
}

variable "state_prefix" {
  type        = string
  description = "Prefix of the landing-zone state in the bucket."
  default     = "gcp-landing-zone"
}

# --- Bifrost engine ----------------------------------------------------------
variable "bifrost_image_tag" {
  type        = string
  description = "Tag of the wavelength-bifrost image in Artifact Registry (built from ../gateway/bifrost/)."
  default     = "v1"
}

variable "bifrost_min_instances" {
  type        = number
  description = "Keep >=1: shared service kept warm. (Operational, not a wake defect: Cloud Run internal ingress DOES wake a service, but cold-starting every app's first model call + the Cloud SQL/config-store warmup is undesirable for a shared gateway.)"
  default     = 1
}

variable "bifrost_cpu" {
  type        = string
  description = "vCPU for the Bifrost container (Go binary; light)."
  default     = "1"
}

variable "bifrost_memory" {
  type        = string
  description = "Memory for the Bifrost container."
  default     = "1Gi"
}

variable "db_admin_login" {
  type        = string
  description = "Shared Cloud SQL admin login (must match the landing zone)."
  default     = "wladmin"
}

# --- oauth2-proxy / OIDC gate ------------------------------------------------
variable "oauth2_proxy_image" {
  type        = string
  description = "oauth2-proxy image. Cloud Run only pulls from *.docker.pkg.dev / gcr.io / docker.io, so the upstream quay.io image must be mirrored into Artifact Registry first (see README). Set the AR path in instance.auto.tfvars."
  default     = "quay.io/oauth2-proxy/oauth2-proxy:v7.7.1"
}

# --- Identity provider (OIDC) ------------------------------------------------
# oauth2-proxy is a generic OIDC client. Entra/M365 ships as the worked example (auto-
# creates the Entra app registration). For another OIDC IdP (e.g. Auth0), set
# create_entra_app_registration = false and supply oidc_issuer_uri/oidc_client_id/
# oidc_client_secret.
variable "create_entra_app_registration" {
  type        = bool
  description = "Auto-create the gateway-UI Entra app registration via the azuread provider (the Entra worked example). Set false to bring your own OIDC IdP and supply the oidc_* inputs."
  default     = true
}

variable "entra_tenant_id" {
  type        = string
  description = "Entra (Azure AD) tenant id - only for the Entra worked example; derives the OIDC issuer and configures the azuread provider. Leave empty for another IdP."
  default     = ""
}

variable "oidc_issuer_uri" {
  type        = string
  description = "OIDC issuer URL for oauth2-proxy. Empty derives the Entra issuer from entra_tenant_id; set explicitly for another IdP."
  default     = ""
}

variable "oidc_client_id" {
  type        = string
  description = "OIDC client id for oauth2-proxy when create_entra_app_registration = false."
  default     = ""
}

variable "oidc_client_secret" {
  type        = string
  sensitive   = true
  description = "OIDC client secret for oauth2-proxy when create_entra_app_registration = false."
  default     = ""
}

variable "oidc_email_claim" {
  type        = string
  description = "Token claim oauth2-proxy treats as the email/identity. Entra v2 reliably emits preferred_username (not always email)."
  default     = "preferred_username"
}

variable "oauth2_proxy_url" {
  type        = string
  description = "Public URL of the deployed oauth2-proxy Cloud Run service (e.g. https://wl-gwui-...run.app). Empty on the FIRST apply (the URL is not known until the service exists); set it on a SECOND apply so the IdP app's redirect URI matches the auto-derived callback. See README."
  default     = ""
}
