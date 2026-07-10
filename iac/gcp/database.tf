# Shared Cloud SQL for PostgreSQL (Stage 2 = "shared"). One instance, a database per
# app. Private IP only - no public endpoint, so it satisfies the deny-public-DB
# posture (and the optional org policy in policy.tf). No scale-to-zero exists for
# Cloud SQL; a shared-core tier (db-f1-micro) is the cheap always-on floor.

resource "random_password" "db_admin" {
  # Alphanumeric only: keeps the DATABASE_URL free of %-escapes (which break alembic's
  # configparser and other URL parsers) and lets wl-entrypoint.sh sed it in unescaped.
  length      = 28
  special     = false
  min_upper   = 2
  min_lower   = 2
  min_numeric = 2
}

resource "google_sql_database_instance" "shared" {
  # Instance names are project-scoped and a deleted name is reserved for ~a week, so
  # carry the instance token to keep re-creates clean.
  name                = "psql-${var.workload}-shared-${local.instance_id}"
  region              = var.region
  database_version    = var.pg_version
  deletion_protection = false # test tier: allow clean teardown

  depends_on = [google_service_networking_connection.psa]

  settings {
    tier = var.db_tier
    # Shared-core tiers (db-f1-micro/db-g1-small) are only valid on ENTERPRISE, not
    # the ENTERPRISE_PLUS default. The cheap always-on floor, the Burstable analogue.
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"
    disk_size         = var.db_disk_size
    disk_autoresize   = true
    user_labels       = local.labels

    ip_configuration {
      # Private access only: no public IPv4, reachable on its private IP from the VPC.
      ipv4_enabled    = false
      private_network = google_compute_network.platform.id
      ssl_mode        = "ENCRYPTED_ONLY"
    }
  }
}

resource "google_sql_user" "admin" {
  name     = var.db_admin_login
  instance = google_sql_database_instance.shared.name
  password = random_password.db_admin.result
  # ABANDON: the admin owns objects across the per-app databases, so DROP USER fails
  # ("cannot be dropped because some objects depend on it") and blocks tofu destroy.
  # Skipping the DROP is safe here - deleting the instance cascades everything anyway.
  deletion_policy = "ABANDON"
}

# Per-app database (drum). Role-per-app (least privilege) is a follow-up; for now the
# app connects as the instance admin to its own database.
resource "google_sql_database" "drum" {
  name     = "drum"
  instance = google_sql_database_instance.shared.name
}

# Bifrost gateway stores (config store + request/usage logs). Bifrost requires UTF8;
# tables are created by Bifrost's own migrations on first boot.
resource "google_sql_database" "bifrost" {
  name     = "bifrost"
  instance = google_sql_database_instance.shared.name
}

# Shared admin registry. Defines users who are admin in EVERY wavelength app. Every
# app's runtime resolves role = admin if the IAP user is in wl_admin.platform_admins
# OR is the app's injected OWNER, else user. Apps connect as the instance admin (same
# follow-up note as drum) so they can read this DB. The platform_admins table + seed
# are applied by a one-off migration step (no tofu SQL over the private IP); see the
# app-stack module / wavelength-sdk.
resource "google_sql_database" "wl_admin" {
  name     = "wl_admin"
  instance = google_sql_database_instance.shared.name
}

# Retiring LiteLLM DB - kept for parity with the Azure landing zone during the
# multi-cloud bring-up; drop once GCP settles on Bifrost only.
resource "google_sql_database" "litellm" {
  name     = "litellm"
  instance = google_sql_database_instance.shared.name
}

# Outline wiki store. Outline runs its own migrations on first boot (see
# outline-gcp/). For now the app connects as the instance admin to its own database;
# role-per-app (least privilege) is the same follow-up noted for drum above.
resource "google_sql_database" "outline" {
  name     = "outline"
  instance = google_sql_database_instance.shared.name
}

# --- Secrets into Secret Manager (never plaintext in config/state) -----------
# The admin password and drum's full DATABASE_URL. Bifrost reads the password via
# WL_DB_PASSWORD; drum's Cloud Run will reference the URL secret.

resource "google_secret_manager_secret" "db_admin_password" {
  secret_id = "shared-db-admin-password"
  labels    = local.labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "db_admin_password" {
  secret      = google_secret_manager_secret.db_admin_password.id
  secret_data = random_password.db_admin.result
}

resource "google_secret_manager_secret" "drum_database_url" {
  secret_id = "drum-database-url"
  labels    = local.labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "drum_database_url" {
  secret = google_secret_manager_secret.drum_database_url.id
  secret_data = format(
    "postgresql://%s:%s@%s:5432/%s?sslmode=require",
    var.db_admin_login,
    random_password.db_admin.result,
    google_sql_database_instance.shared.private_ip_address,
    google_sql_database.drum.name,
  )
}

resource "google_secret_manager_secret" "outline_database_url" {
  secret_id = "outline-database-url"
  labels    = local.labels
  replication {
    auto {}
  }
  depends_on = [google_project_service.apis]
}

resource "google_secret_manager_secret_version" "outline_database_url" {
  secret = google_secret_manager_secret.outline_database_url.id
  # uselibpqcompat=true makes sslmode=require mean "encrypt, do not verify" under the
  # newer node-pg parser (which otherwise treats require as verify-full and rejects the
  # Cloud SQL private-IP cert). Outline is a node app; do NOT add this to drum's URL
  # (psycopg/libpq does not understand the param).
  secret_data = format(
    "postgresql://%s:%s@%s:5432/%s?sslmode=require&uselibpqcompat=true",
    var.db_admin_login,
    random_password.db_admin.result,
    google_sql_database_instance.shared.private_ip_address,
    google_sql_database.outline.name,
  )
}
