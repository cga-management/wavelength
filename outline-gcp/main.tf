# Outline wiki on GCP - the first app to consume the shared IAP perimeter.
#
# Reads two pieces of platform state so nothing is duplicated or hand-passed:
#   - landing zone (lz)  : network, Cloud SQL, Artifact Registry, app SA, secrets
#   - org edge   (edge)  : the shared workforce-WIF identity, IAP brand/client, and
#                          Cloud Armor policies built once in ../iac/gcp-org/
#
# Outline differs from Bifrost: it is a full app with its OWN OIDC login, so it
# is the public surface itself (fronted by the LB), not something hidden behind
# oauth2-proxy. The IAP perimeter sits in front purely to stop unauthenticated
# traffic ever reaching Outline's login/API/fuzz surface.

data "terraform_remote_state" "platform" {
  backend = "gcs"
  config = {
    bucket = var.state_bucket
    prefix = var.state_prefix
  }
}

data "terraform_remote_state" "edge" {
  backend = "gcs"
  config = {
    bucket = var.state_bucket
    prefix = var.edge_state_prefix
  }
}

locals {
  lz   = data.terraform_remote_state.platform.outputs
  edge = data.terraform_remote_state.edge.outputs

  # Same deterministic token the landing zone derives (iac/gcp/main.tf), for the few
  # globally/project-unique names this stack creates (the uploads bucket).
  instance_id = substr(sha1("${var.project_id}-${var.workload}"), 0, 8)

  outline_image = "${local.lz.artifact_registry_repo}/outline:${var.outline_image_tag}"
  redis_image   = "${local.lz.artifact_registry_repo}/redis:${var.redis_image_tag}"

  outline_url = "https://${var.outline_hostname}"

  # OIDC client id + endpoints. The Entra worked example derives endpoints from the
  # tenant; override any of the oidc_* vars for another IdP. one(...[*]...) is index-safe
  # whichever branch the conditional discards.
  oidc_client_id    = var.create_entra_app_registration ? one(azuread_application.outline_gcp[*].client_id) : var.oidc_client_id
  oidc_auth_uri     = var.oidc_auth_uri != "" ? var.oidc_auth_uri : "https://login.microsoftonline.com/${var.entra_tenant_id}/oauth2/v2.0/authorize"
  oidc_token_uri    = var.oidc_token_uri != "" ? var.oidc_token_uri : "https://login.microsoftonline.com/${var.entra_tenant_id}/oauth2/v2.0/token"
  oidc_userinfo_uri = var.oidc_userinfo_uri != "" ? var.oidc_userinfo_uri : "https://graph.microsoft.com/oidc/userinfo"
}
