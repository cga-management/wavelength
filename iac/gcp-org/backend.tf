# Remote state. Same GCS bucket as the landing zone; distinct prefix. Supplied at
# `tofu init` (partial backend config). Although this stack is human-run, its state
# lives alongside the others so app stacks can read its outputs (gcp-org-edge).
terraform {
  backend "gcs" {
    # bucket = supplied at init (e.g. wl-tfstate-<token>)
    # prefix = "gcp-org-edge"
  }
}
