variable "name_prefix" {
  type        = string
  description = "Prefix for the LB resource names, e.g. 'wl-outline-platform'."
}

variable "project_id" {
  type        = string
  description = "GCP project id (needed to build the IAP settings resource name)."
}

variable "region" {
  type        = string
  description = "Region of the Cloud Run service the serverless NEG targets."
}

variable "cloud_run_service" {
  type        = string
  description = "Name of the Cloud Run service to front (a single serverless NEG points at it; all routes share it)."
}

# The shared workforce-WIF + IAP identity, produced once by ../../gcp-org/ and passed
# in by the calling app stack. Only consumed by routes with enable_iap = true.
variable "workforce_pool" {
  type        = string
  description = "Full workforce pool resource name, e.g. locations/global/workforcePools/<pool>. Empty if no IAP route is used."
  default     = ""
}

variable "iap_oauth2_client_id" {
  type        = string
  description = "OAuth2 client id created for the Workforce Identity Federation IAP flow (see ../../gcp-org/)."
  default     = ""
}

variable "iap_oauth2_client_secret" {
  type        = string
  description = "OAuth2 client secret paired with iap_oauth2_client_id."
  sensitive   = true
  default     = ""
}

variable "iap_members" {
  type        = list(string)
  description = "IAM members granted roles/iap.httpsResourceAccessor on IAP-enabled backends, e.g. the workforce-pool principalSet. Required if any route has enable_iap = true."
  default     = []
}

# One entry per public hostname. All routes fan in to the same Cloud Run service via a
# single serverless NEG; they differ only in IAP on/off and which Cloud Armor policy
# guards them. This is what lets one host be IAP-gated (humans) and another be
# IAP-bypassed + Anthropic-IP-locked (MCP) on the same LB/IP/cert.
variable "routes" {
  type = list(object({
    hostname        = string
    enable_iap      = bool
    security_policy = optional(string) # Cloud Armor policy self-link, or null
  }))
  description = "Public hostnames to serve, each with its IAP toggle and optional Cloud Armor policy."
}
