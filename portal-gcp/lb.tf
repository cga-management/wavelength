# Front the portal with the shared external HTTPS LB + IAP perimeter. ONE hostname
# (e.g. portal.labs.example.com), IAP-gated, Cloud Armor sso-default (human host). The portal
# reads the user from the IAP JWT it verifies (unlike outline, which runs its own OIDC),
# so this is a true archetype-A app: the LB backend's numeric id becomes the IAP audience
# the portal checks (two-phase; see computed_iap_audience in outputs.tf).
#
# The IAP OAuth client secret lives in Secret Manager (created by ../iac/gcp-org/); read
# it here to pass into the LB backend's IAP config.
data "google_secret_manager_secret_version" "iap_client_secret" {
  secret = local.edge.iap_client_secret_id
}

module "lb" {
  # Referenced in-repo (the portal is a platform stack applied from this repo, like
  # outline-gcp). Self-deploy through deploy-app.yml would instead need the module
  # vendored + a context-dir workflow input (upstream candidate; see README).
  source = "../iac/modules/iap-lb"

  name_prefix       = "${var.workload}-portal-${var.environment}"
  project_id        = var.project_id
  region            = var.region
  cloud_run_service = google_cloud_run_v2_service.portal.name

  # Instant wildcard TLS from the platform certificate map (no per-host managed cert, no
  # 15-60 min provisioning wait). Falls back to a classic managed cert if the map output
  # is absent on an older landing zone.
  certificate_map = try(local.lz.certificate_map_id, null)

  workforce_pool           = local.edge.workforce_pool_name
  iap_oauth2_client_id     = local.edge.iap_oauth_client_id
  iap_oauth2_client_secret = data.google_secret_manager_secret_version.iap_client_secret.secret_data
  iap_members              = ["principalSet://iam.googleapis.com/${local.edge.workforce_pool_name}/*"]

  routes = [
    {
      hostname        = var.portal_hostname
      enable_iap      = true
      security_policy = try(local.edge.armor_sso_default_id, null)
    },
  ]
}
