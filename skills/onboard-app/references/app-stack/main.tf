# Read the two platform states so nothing is duplicated or hand-passed:
#   lz   (landing zone) : network, Cloud SQL instance name + private IP, Artifact Registry, app SA, DNS zone
#   edge (org edge)     : shared workforce identity, IAP OAuth client, Cloud Armor policies
data "terraform_remote_state" "platform" {
  backend = "gcs"
  config  = { bucket = var.state_bucket, prefix = var.state_prefix }
}

data "terraform_remote_state" "edge" {
  backend = "gcs"
  config  = { bucket = var.state_bucket, prefix = var.edge_state_prefix }
}

locals {
  lz   = data.terraform_remote_state.platform.outputs
  edge = data.terraform_remote_state.edge.outputs

  app_image = "${local.lz.artifact_registry_repo}/myapp:${var.image_tag}"
}
