# Remote state. The backing GCS bucket is created by ../bootstrap/gcp/bootstrap.sh.
# Values are supplied at `tofu init` (partial backend config) so nothing is hardcoded.
terraform {
  backend "gcs" {
    # CI authenticates via Workload Identity Federation; locally via ADC. No keys.
    # bucket = supplied at init (e.g. wl-tfstate-<token>)
    # prefix = "gcp-landing-zone"
  }
}
