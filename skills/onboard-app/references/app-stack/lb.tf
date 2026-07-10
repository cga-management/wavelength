# Front myapp with the shared external HTTPS LB + IAP. One IAP-gated route; the Cloud Run
# service stays internal-ingress. IAP authenticates every request against the org SSO and
# passes the signed identity JWT to the app (see ../iap-identity.md).
data "google_secret_manager_secret_version" "iap_client_secret" {
  secret = local.edge.iap_client_secret_id
}

module "lb" {
  # Vendored copy of the platform's iac/modules/iap-lb (see README for how to obtain it).
  source = "./modules/iap-lb"

  name_prefix       = "${var.workload}-myapp-${var.environment}"
  project_id        = var.project_id
  region            = var.region
  cloud_run_service = google_cloud_run_v2_service.app.name

  workforce_pool           = local.edge.workforce_pool_name
  iap_oauth2_client_id     = local.edge.iap_oauth_client_id
  iap_oauth2_client_secret = data.google_secret_manager_secret_version.iap_client_secret.secret_data
  iap_members              = ["principalSet://iam.googleapis.com/${local.edge.workforce_pool_name}/*"]

  # Platform wildcard TLS via Certificate Manager: adopt the landing zone's certificate
  # map when it exists (instant TLS, no per-host cert). On a landing zone that predates
  # the map the output is absent, so fall back to null and the module provisions a
  # classic per-host managed cert (15-60 min on first deploy).
  certificate_map = try(local.lz.certificate_map_id, null)

  routes = [
    {
      hostname        = var.app_hostname
      enable_iap      = true
      security_policy = try(local.edge.armor_sso_default_id, null)
    },
  ]
}
