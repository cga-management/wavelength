# Outline's own application secrets. SECRET_KEY encrypts data at rest (cookies, auth
# state); UTILS_SECRET signs internal/util tokens. Outline wants 32-byte hex for each
# (the historic `openssl rand -hex 32`). random_id with byte_length 32 -> 64 hex
# chars. NOTE: once set, rotating SECRET_KEY invalidates existing sessions/at-rest
# crypto - treat as stable, like Bifrost's encryption key.

resource "random_id" "secret_key" {
  byte_length = 32
}

resource "google_secret_manager_secret" "secret_key" {
  secret_id = "outline-secret-key"
  labels    = local.lz.labels
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "secret_key" {
  secret      = google_secret_manager_secret.secret_key.id
  secret_data = random_id.secret_key.hex
}

resource "random_id" "utils_secret" {
  byte_length = 32
}

resource "google_secret_manager_secret" "utils_secret" {
  secret_id = "outline-utils-secret"
  labels    = local.lz.labels
  replication {
    auto {}
  }
}

resource "google_secret_manager_secret_version" "utils_secret" {
  secret      = google_secret_manager_secret.utils_secret.id
  secret_data = random_id.utils_secret.hex
}
