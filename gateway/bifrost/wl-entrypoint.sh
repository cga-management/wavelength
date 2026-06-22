#!/bin/sh
# Render config.json from the template using env vars, then hand off to the
# upstream entrypoint. Secrets (DB password, encryption key) are substituted
# here at boot - they exist only as env vars sourced from Key Vault, never in
# the image or the repo. Values referenced as env.X inside the template are
# resolved by Bifrost itself at load time and are NOT substituted here.
set -e

APP_DIR=${APP_DIR:-/app/data}
mkdir -p "$APP_DIR"

: "${WL_DB_HOST:?WL_DB_HOST is required}"
: "${WL_DB_USER:?WL_DB_USER is required}"
: "${WL_DB_PASSWORD:?WL_DB_PASSWORD is required}"

# sed-based substitution; values are alphanumeric by platform convention
# (see iac/azure/database.tf random_password), so no escaping is needed.
sed \
  -e "s|__WL_DB_HOST__|${WL_DB_HOST}|g" \
  -e "s|__WL_DB_USER__|${WL_DB_USER}|g" \
  -e "s|__WL_DB_PASSWORD__|${WL_DB_PASSWORD}|g" \
  /app/config.json.tmpl > "$APP_DIR/config.json"

exec /app/docker-entrypoint.sh "$@"
