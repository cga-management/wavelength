# GCP providers. CI authenticates via Workload Identity Federation (no stored
# secret); locally via Application Default Credentials (`gcloud auth
# application-default login`).
#
# Use ADC, NOT a static GOOGLE_OAUTH_ACCESS_TOKEN, for any apply here. A static
# token cannot be refreshed, so a long-running create (the Cloud SQL instance takes
# 10-15 min) outlives it and the apply 401s mid-operation - leaving the instance
# created on GCP but absent from state. ADC refreshes automatically and avoids this.
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
