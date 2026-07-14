# The portal's OWN dedicated runtime service account - the THIRD sanctioned deviation from
# the portal doctrine (docs/portal.md; documented in README.md "Third sanctioned
# deviation"). The portal historically ran as the SHARED app SA (id-wl-platform), like
# outline, holding no cloud credentials of its own. The per-app Logs panel needs live
# Cloud Logging reads, and a live read cannot be an out-of-process collector (Layer 2) -
# it happens in-request. Adding roles/logging.viewer to the shared SA would cascade
# log-read onto EVERY tenant app that inherits it, which is exactly the grant creep the
# platform's least-privilege stance exists to prevent. So the portal gets its own SA and
# the one new cloud capability lands here alone: read-only, and per-app scoped in the app
# (the Logging filter pins one Cloud Run service; the route gates on canSeeCostUsage).
#
# This SA is scoped no wider than the shared SA it replaces: it re-declares the same three
# roles the portal actually used (cloudsql.client, artifactregistry.reader, and secret
# access - but tightened to the TWO portal secrets rather than the shared SA's project-wide
# secretAccessor), plus the single new logging.viewer. Nothing the shared SA holds is
# removed - tenant apps keep using it.
resource "google_service_account" "portal" {
  account_id   = "id-${var.workload}-portal"
  display_name = "Wavelength admin portal runtime"
}

# THE new capability: read-only Cloud Logging. Project-scoped viewer is the least role that
# serves entries:list; a caller only ever sees their own app's logs because the app pins
# the filter to one service_name and gates the route - IAM does not (and need not) scope
# per app here.
resource "google_project_iam_member" "portal_logging_viewer" {
  project = var.project_id
  role    = "roles/logging.viewer"
  member  = "serviceAccount:${google_service_account.portal.email}"
}

# Connect to the shared Cloud SQL (wl_admin over the private IP) - same role the portal
# relied on via the shared SA. Cloud Run pairs network reachability with this IAM role.
resource "google_project_iam_member" "portal_cloudsql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.portal.email}"
}

# Pull the portal image from Artifact Registry (the shared SA had this project-wide; the
# collector SA takes the same project-wide grant - mirror that).
resource "google_project_iam_member" "portal_artifact_reader" {
  project = var.project_id
  role    = "roles/artifactregistry.reader"
  member  = "serviceAccount:${google_service_account.portal.email}"
}

# Read ONLY the two portal secrets it mounts as env (DATABASE_URL, PORTAL_GITHUB_TOKEN).
# Deliberately tighter than the shared SA's project-wide secretAccessor: the dedicated SA
# can reach exactly these two secrets and no others.
resource "google_secret_manager_secret_iam_member" "portal_database_url" {
  secret_id = google_secret_manager_secret.portal_database_url.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.portal.email}"
}

resource "google_secret_manager_secret_iam_member" "portal_github_token" {
  secret_id = google_secret_manager_secret.portal_github_token.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.portal.email}"
}
