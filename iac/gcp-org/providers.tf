# Org-edge stack: the shared human-SSO perimeter for ALL wavelength apps on GCP -
# Workforce Identity Federation (Entra) + the IAP OAuth client + shared Cloud Armor
# policies. Built ONCE per org.
#
# Run by a HUMAN day-to-day admin (not CI): the workforce pool is an ORG-level
# resource needing roles/iam.workforcePoolAdmin, which the project-scoped CI service
# account deliberately does not hold. See ../bootstrap/gcp/ORG-SETUP.md.
#
# google      : workforce pool/provider (org-level), Cloud Armor (project-level).
# google-beta : workforce pool web-sso config / any beta-only IAP arguments.
# azuread     : the Entra app registration the workforce provider + IAP sign in with -
#               ONLY when create_entra_app_registration = true (the Entra worked example).
#               For another OIDC IdP it stays unused (entra_tenant_id may be empty).
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
}
