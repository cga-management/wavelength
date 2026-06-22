# Wavelength model gateway on GCP - Bifrost on Cloud Run. Reads the platform
# foundation (network, Cloud SQL, Artifact Registry, app service account, secrets)
# from the landing-zone state, so nothing is duplicated or hand-passed.

data "terraform_remote_state" "platform" {
  backend = "gcs"
  config = {
    bucket = var.state_bucket
    prefix = var.state_prefix
  }
}

locals {
  lz = data.terraform_remote_state.platform.outputs
}
