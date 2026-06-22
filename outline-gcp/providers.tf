# Outline wiki stack providers (GCP). The first app to sit behind the shared IAP
# perimeter (../iac/gcp-org/). Reuses the platform foundation (network, Cloud SQL,
# Artifact Registry, app service account, secrets) and the org-edge identity.
#
# google      : Cloud Run (multi-container), GCS, Secret Manager, the external HTTPS
#               load balancer + backend (IAP), IAM. Auth via ADC / access token
#               (local) or Workload Identity Federation (CI).
# google-beta : load-balancer / IAP arguments that live in the beta provider.
# azuread     : Outline's OWN Entra app registration (wl-outline-oidc-gcp) for its
#               native OIDC login - ONLY when create_entra_app_registration = true (the
#               Entra worked example; auth via `az login`). For another OIDC IdP it stays
#               unused and you supply the oidc_* inputs instead.
terraform {
  required_version = ">= 1.6.0" # OpenTofu
  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 6.0"
    }
    google-beta = {
      source  = "hashicorp/google-beta"
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

provider "google-beta" {
  project = var.project_id
  region  = var.region
}

provider "azuread" {
  tenant_id = var.entra_tenant_id
  # Uses the Azure CLI login (az login) locally.
}
