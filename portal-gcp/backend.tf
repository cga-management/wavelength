# Remote state in the shared GCS bucket (same bucket as the landing zone; distinct
# prefix). Supplied at `tofu init` (partial backend config):
#   tofu init -backend-config="bucket=<STATE_BUCKET>" -backend-config="prefix=gcp-portal"
terraform {
  backend "gcs" {
    # bucket = supplied at init (e.g. wl-tfstate-<token>)
    # prefix = "gcp-portal"
  }
}
