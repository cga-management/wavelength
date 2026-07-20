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

# --- Remote state -----------------------------------------------------------
variable "state_bucket" {
  type        = string
  description = "GCS bucket holding the tofu state (shared across stacks)."
}

variable "state_prefix" {
  type        = string
  description = "Prefix of the landing-zone state in the bucket."
  default     = "gcp-landing-zone"
}

variable "edge_state_prefix" {
  type        = string
  description = "Prefix of the org-edge (IAP/WIF/Cloud Armor) state in the bucket."
  default     = "gcp-org-edge"
}

# --- Portal ------------------------------------------------------------------
variable "portal_hostname" {
  type        = string
  description = "Public hostname for the portal (IAP-gated), e.g. portal.labs.example.com."
}

variable "portal_image_tag" {
  type        = string
  description = "Tag of the portal image in Artifact Registry (repo ar-<workload>-<environment>, image 'portal')."
  default     = "latest"
}

# Seeds wl_admin.platform_admins on boot (ON CONFLICT DO NOTHING) and owns the portal's
# own registry card. A registry with zero platform admins cannot do a first deploy, so
# seed at least one operator here.
variable "bootstrap_admin_email" {
  type        = string
  description = "Email seeded into platform_admins on portal boot (also the portal card owner). MUST be the IdP identity the workforce subject resolves to - for the Entra worked example, the operator's UPN - not any other alias. In a two-directory setup (Google Cloud Identity for gcloud, Entra for the platform) these differ, and a non-UPN value seeds an admin row no sign-in ever matches. Normalized by the app."
  default     = ""
}

# Two-phase IAP audience: leave "" on the first apply, then set to the computed_iap_audience
# output (tofu output -raw computed_iap_audience) and re-apply. The app fails closed on
# every request until this is set - the intended behaviour between the two applies.
variable "iap_audience" {
  type        = string
  description = "IAP JWT audience for the portal backend. Empty on phase 1; set to computed_iap_audience on phase 2."
  default     = ""
}

# The GitHub token secret (portal-github-token) is created with NO version by this stack;
# the operator seeds the PAT later. The Cloud Run secret env is only wired when this is
# true, so the portal boots (Deploy button disabled) before the token exists. After
# seeding a version, set this true and re-apply.
variable "github_token_wired" {
  type        = bool
  description = "Wire the portal-github-token secret into the portal as PORTAL_GITHUB_TOKEN. Keep false until a secret version is seeded, then set true and re-apply."
  default     = false
}

variable "platform_repo" {
  type        = string
  description = "owner/repo that hosts deploy-app.yml (the platform repo the portal dispatches deploys to). No default - supplied per instance."
}

# --- Sizing ------------------------------------------------------------------
variable "portal_min_instances" {
  type        = number
  description = "Min Cloud Run instances (scale to zero)."
  default     = 0
}

variable "portal_max_instances" {
  type        = number
  description = "Max Cloud Run instances."
  default     = 2
}

variable "portal_cpu" {
  type        = string
  default     = "1"
  description = "vCPU for the portal container."
}

variable "portal_memory" {
  type        = string
  default     = "512Mi"
  description = "Memory for the portal container."
}

# --- Collector ---------------------------------------------------------------
variable "collector_schedule" {
  type        = string
  description = "Cloud Scheduler cron for the collectors (UTC). Two firings: the billing export can transiently read empty during its own rewrite window (observed around 02:00 UTC - three consecutive nights of zero-row reads on a populated table), so avoid the small hours and fire twice so one bad read never costs a day of staleness. Upserts make the second run converge, never double-count."
  default     = "0 5,13 * * *"
}

variable "collector_cpu" {
  type        = string
  default     = "1"
  description = "vCPU for the collector job."
}

variable "collector_memory" {
  type        = string
  default     = "512Mi"
  description = "Memory for the collector job."
}

# --- Scheduler -----------------------------------------------------------------
variable "scheduler_tick" {
  type        = string
  description = "Cloud Scheduler cron for the deploy-schedule tick (UTC). Every 5 minutes: the UI tells users a one-off fires within about 5 minutes of its time, so do not slow this below that promise. Fires are at-most-once (rows are advanced before dispatch), so a faster tick is safe but pointless."
  default     = "*/5 * * * *"
}

variable "scheduler_cpu" {
  type        = string
  default     = "1"
  description = "vCPU for the scheduler job."
}

variable "scheduler_memory" {
  type        = string
  default     = "512Mi"
  description = "Memory for the scheduler job."
}
