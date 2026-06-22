# Front Outline with the shared external HTTPS LB + IAP perimeter. One LB / IP / cert
# serves both hostnames against the SAME Cloud Run service:
#   - var.outline_hostname : IAP on (workforce/your IdP), Cloud Armor sso-default. Humans.
#   - var.mcp_hostname     : IAP off, Cloud Armor anthropic-only. The Anthropic MCP
#                            connector authenticates with an Outline API token instead.
#
# The IAP OAuth client secret lives in Secret Manager (created by ../iac/gcp-org/); read
# it here to pass into the LB backend's IAP config.

data "google_secret_manager_secret_version" "iap_client_secret" {
  secret = local.edge.iap_client_secret_id
}

module "lb" {
  source = "../iac/modules/iap-lb"

  name_prefix       = "${var.workload}-outline-${var.environment}"
  project_id        = var.project_id
  region            = var.region
  cloud_run_service = google_cloud_run_v2_service.outline.name

  # Shared workforce identity + the GCP IAP OAuth client from the org-edge stack.
  # (IAP uses the GCP oauth client, NOT the Entra app - auth.cloud.google validates it.)
  workforce_pool           = local.edge.workforce_pool_name
  iap_oauth2_client_id     = local.edge.iap_oauth_client_id
  iap_oauth2_client_secret = data.google_secret_manager_secret_version.iap_client_secret.secret_data

  # Authorize everyone in the Entra workforce pool to pass IAP on the human host.
  iap_members = ["principalSet://iam.googleapis.com/${local.edge.workforce_pool_name}/*"]

  # Cloud Armor is optional in the org-edge stack (SECURITY_POLICIES quota gate). When
  # disabled, those outputs are null and dropped from remote state, so tolerate their
  # absence: the UI host still gets IAP; the MCP host is unprotected until Cloud Armor
  # lands (see iac/gcp-org enable_cloud_armor).
  routes = [
    {
      hostname        = var.outline_hostname
      enable_iap      = true
      security_policy = try(local.edge.armor_sso_default_id, null)
    },
    {
      hostname        = var.mcp_hostname
      enable_iap      = false
      security_policy = try(local.edge.armor_anthropic_only_id, null)
    },
  ]
}
