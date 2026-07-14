# Portal control-plane stack providers (GCP). google-beta is required by the iap-lb
# module (google_iap_settings lives in the beta provider). No azuread: the portal
# inherits the shared IAP identity and runs no OIDC of its own - it reads the user from
# the IAP JWT (skills/onboard-app/references/iap-identity.md).
terraform {
  required_version = ">= 1.6.0" # OpenTofu
  required_providers {
    google      = { source = "hashicorp/google", version = "~> 6.0" }
    google-beta = { source = "hashicorp/google-beta", version = "~> 6.0" }
    random      = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "google-beta" {
  project = var.project_id
  region  = var.region
}
