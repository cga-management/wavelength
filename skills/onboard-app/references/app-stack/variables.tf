variable "project_id" { type = string }
variable "region" {
  type    = string
  default = "europe-west2"
}
variable "workload" {
  type    = string
  default = "wl"
}
variable "environment" {
  type    = string
  default = "platform"
}

# Shared OpenTofu state (from bootstrap). Prefixes default to the platform convention.
variable "state_bucket" { type = string }
variable "state_prefix" {
  type    = string
  default = "gcp-landing-zone"
}
variable "edge_state_prefix" {
  type    = string
  default = "gcp-org-edge"
}

# Public hostname under the delegated app subdomain, e.g. myapp.internal.example.com
variable "app_hostname" { type = string }

# Mirrored image tag in Artifact Registry (see ../deploy.md).
variable "image_tag" {
  type    = string
  default = "latest"
}

# The deploying developer's email = the app OWNER (always treated as admin, even before
# wl_admin.platform_admins is seeded). See ../shared-db-rls.md.
variable "app_owner_email" { type = string }

# Two-phase: leave "" on the first apply, then set to the computed_iap_audience output
# (tofu output -raw computed_iap_audience) and re-apply. The deploy-app workflow runs
# both phases automatically.
variable "iap_audience" {
  type    = string
  default = ""
}
