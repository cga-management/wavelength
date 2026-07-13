# The one narrowly-scoped credential the portal holds: a GitHub token with actions:write
# on the platform repo ONLY, used to dispatch deploy-app.yml (docs/portal.md). tofu
# creates the secret container with NO version; the operator seeds the PAT value later
# (out of band, never in tofu state or git), exactly like the landing zone's
# operator-supplied keys (iac/gcp/secrets.tf).
#
# Until a version exists the token env is NOT wired into the portal (var.github_token_wired
# = false), so the portal boots fine and renders the Deploy button disabled with a
# "dispatch token not configured" note. After seeding a version, set
# github_token_wired = true and re-apply.
resource "google_secret_manager_secret" "portal_github_token" {
  secret_id = "portal-github-token"
  labels    = local.lz.labels
  replication {
    auto {}
  }
}

# Deliberately NO google_secret_manager_secret_version here - the operator adds it:
#   printf '%s' "$PAT" | gcloud secrets versions add portal-github-token --data-file=- --project=<PROJECT_ID>
