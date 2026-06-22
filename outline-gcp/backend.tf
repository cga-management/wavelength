# Remote state. Same GCS bucket as the landing zone (bootstrap.sh made it); only the
# prefix differs. Supplied at `tofu init` (partial backend config).
terraform {
  backend "gcs" {
    # bucket = supplied at init (e.g. wl-tfstate-<token>)
    # prefix = "gcp-outline"
  }
}
