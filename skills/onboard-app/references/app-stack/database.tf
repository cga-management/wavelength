# myapp's slice of the shared Cloud SQL instance, self-provisioned on FIRST deploy.
# The deploy workflow's CI identity holds cloudsql.admin + secretmanager.admin, so this
# stack creates the database, the app's OWN database user, and the connection-string
# secret itself - no landing-zone edit, no operator SQL. Instance name and private IP
# come from landing-zone remote state (main.tf).
#
# Naming: Postgres identifiers use underscores, so a hyphenated slug becomes
# "my_app" / "my_app_app" in the database/user names below, while the Secret Manager
# secret_id keeps the hyphens ("my-app-database-url").
#
# Cloud SQL semantics worth knowing (they shape the one-time hardening step):
#   - API-created USERS are members of the cloudsqlsuperuser role.
#   - API-created DATABASES are owned by cloudsqlsuperuser.
# Net effect: myapp_app can create tables in its own database out of the box (on PG15+
# too, via the cloudsqlsuperuser membership), so boot migrations just work on a fresh
# slice. BUT credential isolation from other apps is PARTIAL until the operator runs the
# one-time hardening SQL in ../db-hardening.md (reassign the database ownership to
# myapp_app, revoke cloudsqlsuperuser). The main win stands regardless: the DSN no
# longer contains the instance admin.

resource "random_password" "db_app_user" {
  # Alphanumeric only: keeps the DSN free of %-escapes, which break URL parsers, and
  # lets the password be embedded in the secret unencoded.
  length      = 32
  special     = false
  min_upper   = 2
  min_lower   = 2
  min_numeric = 2
}

resource "google_sql_database" "app" {
  name     = "myapp"
  instance = local.lz.db_instance_name
  # Destroy ordering: tofu destroys in reverse dependency order, so this makes the
  # database go BEFORE the user. After the db-hardening step myapp_app owns this
  # database and its objects, and the shared instance survives an app teardown, so
  # the DROP USER must actually succeed - without this ordering it fails with
  # 'role "myapp_app" cannot be dropped because some objects depend on it'.
  # (ABANDON is the wrong fix here: it would orphan the user on the shared instance.)
  depends_on = [google_sql_user.app]
}

resource "google_sql_user" "app" {
  name     = "myapp_app"
  instance = local.lz.db_instance_name
  password = random_password.db_app_user.result
}

resource "google_secret_manager_secret" "database_url" {
  secret_id = "myapp-database-url"
  labels    = local.lz.labels
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "database_url" {
  secret = google_secret_manager_secret.database_url.id
  # sslmode=require = encrypt without verifying the private-IP cert.
  # uselibpqcompat=true makes sslmode=require mean "encrypt, do not verify" under the
  # newer node/pg parser (which otherwise treats require as verify-full and rejects the
  # Cloud SQL private-IP cert). Node apps ONLY - psycopg/libpq does not understand the
  # param, so DROP "&uselibpqcompat=true" for a python app.
  secret_data = format(
    "postgresql://%s:%s@%s:5432/%s?sslmode=require&uselibpqcompat=true",
    google_sql_user.app.name,
    random_password.db_app_user.result,
    local.lz.db_private_ip,
    google_sql_database.app.name,
  )
}
