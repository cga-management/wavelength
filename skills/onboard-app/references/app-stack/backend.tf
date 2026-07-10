# Remote state in the shared GCS bucket (same bucket as the platform; distinct prefix).
# Bucket + prefix are supplied at `tofu init` (partial backend config):
#   tofu init -backend-config="bucket=<STATE_BUCKET>" -backend-config="prefix=gcp-myapp"
terraform {
  backend "gcs" {
    # bucket = supplied at init
    # prefix = "gcp-myapp"
  }
}
