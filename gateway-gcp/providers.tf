# Gateway stack providers (GCP). The GCP sibling of gateway/ - same Bifrost image
# (../gateway/bifrost/, reused unchanged), mapped onto Cloud Run + Secret Manager.
#
# google      : Cloud Run, Secret Manager, IAM. Auth via ADC / access token (local)
#               or Workload Identity Federation (CI).
# azuread     : the Entra app registration that fronts the UI - ONLY when
#               create_entra_app_registration = true (the Entra worked example; its OWN
#               app reg wl-gateway-ui-gcp, auth via `az login`). For another OIDC IdP it
#               stays unused and you supply the oidc_* inputs instead.
terraform {
  required_version = ">= 1.6.0" # OpenTofu
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    azuread = {
      source  = "hashicorp/azuread"
      version = "~> 3.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }
}

provider "google" {
  project = var.project_id
  region  = var.region
}

provider "azuread" {
  tenant_id = var.entra_tenant_id
  # Uses the Azure CLI login (az login) locally.
}
