# File storage for Outline uploads (attachments, avatars, imports).
#
# A secure-by-default org enforces constraints/iam.disableServiceAccountKeyCreation, and
# a GCS HMAC key counts as a service-account key - so the S3-interop approach is blocked
# by policy. Instead we mount the bucket straight into the Cloud Run container with
# gcsfuse (see outline.tf volumes) and run Outline with FILE_STORAGE=local pointed at
# the mount. gcsfuse authenticates as the app service account via IAM (the
# objectAdmin binding below) - no key, so it satisfies the org policy and stays durable
# across revision restarts.

resource "google_storage_bucket" "outline" {
  name     = "${var.workload}-outline-uploads-${local.instance_id}"
  project  = var.project_id
  location = var.region

  uniform_bucket_level_access = true
  public_access_prevention    = "enforced"

  labels = local.lz.labels
}

# gcsfuse reads/writes as the app service account; objectAdmin covers create/read/delete.
resource "google_storage_bucket_iam_member" "outline_object_admin" {
  bucket = google_storage_bucket.outline.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${local.lz.app_service_account_email}"
}
