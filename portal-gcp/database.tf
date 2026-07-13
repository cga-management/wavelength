# The portal's DB user on the shared Cloud SQL instance, plus its connection-string
# secret. Mirrors the established self-provisioning pattern (iac/gcp/database.tf and the
# onboard-app app-stack/database.tf): the user is created via the Cloud SQL Admin API,
# which works on the private-IP-only instance because it is an API call, not a psql
# connection - there is no tofu SQL over the private IP anywhere in this repo.
#
# The portal deviates from tenant apps by using wl_admin DIRECTLY (docs/portal.md): it
# does not get its own database, because wl_admin IS the registry it manages. The
# platform_admins table already lives there; the portal adds the registry tables via its
# idempotent boot migrations.
#
# Cloud SQL semantics (same as app-stack/database.tf): API-created users are members of
# cloudsqlsuperuser, so portal_app can CREATE its tables in wl_admin (owned by
# cloudsqlsuperuser) and read/write platform_admins out of the box - boot migrations just
# work with no operator SQL. Confining that further (revoking cloudsqlsuperuser) is a
# later hardening step (db-hardening.md) and is NOT required for the portal to run.

resource "random_password" "portal_db_user" {
  # Alphanumeric only: keeps the DSN free of %-escapes (which break URL parsers) and lets
  # the password be embedded in the secret unencoded.
  length      = 32
  special     = false
  min_upper   = 2
  min_lower   = 2
  min_numeric = 2
}

resource "google_sql_user" "portal" {
  name     = "portal_app"
  instance = local.lz.db_instance_name
  password = random_password.portal_db_user.result
  # ABANDON on destroy: portal_app owns the registry tables it created in the SHARED
  # wl_admin database, so a plain DROP USER fails ("objects depend on it") and the shared
  # instance survives a portal teardown anyway. (Same reasoning as the landing zone's
  # admin user.)
  deletion_policy = "ABANDON"
}

resource "google_secret_manager_secret" "portal_database_url" {
  secret_id = "portal-database-url"
  labels    = local.lz.labels
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "portal_database_url" {
  secret = google_secret_manager_secret.portal_database_url.id
  # Node app: sslmode=require&uselibpqcompat=true = "encrypt, do not verify" against the
  # Cloud SQL private-IP cert under the newer node-pg parser. The portal connects to the
  # SHARED wl_admin database as its own portal_app user.
  secret_data = format(
    "postgresql://%s:%s@%s:5432/%s?sslmode=require&uselibpqcompat=true",
    google_sql_user.portal.name,
    random_password.portal_db_user.result,
    local.lz.db_private_ip,
    local.lz.wl_admin_database,
  )
}

# The portal runtime SA (the shared app SA) can already read secrets via the landing
# zone's project-level secretAccessor grant, so no extra IAM here for the app. The
# collector SA gets its own explicit grant (collector.tf).
