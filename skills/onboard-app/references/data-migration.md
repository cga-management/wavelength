# Migrating existing local data into the shared DB

Onboarding a copy usually means bringing the app's existing data with it (the point is to
get the data into the shared space for central review). Two constraints shape how:

- The shared Cloud SQL is **private-IP only** - the user's laptop cannot connect to it.
- The user has **no GCP access** - the load is an operator step.

So the pattern is: **user exports locally and hands off; operator loads it server-side via
Cloud SQL's GCS import** (which pulls the dump from a bucket, needing no direct network path
to the private IP). Then ownership is stamped so per-user RLS actually shows the data.

This applies to the app's **Postgres** data (the common case). Redis is usually ephemeral
(rebuilt, skip it); uploaded files go to the app's GCS bucket, not here.

## App-side (user / their agent)

1. **Export the local data.** Data-only, since the deployed app already created its schema
   on first boot (see `shared-db-rls.md`):
   ```bash
   pg_dump --data-only --no-owner --no-privileges "$LOCAL_DATABASE_URL" > app-data.sql
   ```
   If the local schema predates the ownership column (it will - the local app was not
   multi-user), that is fine: you add ownership at load time (below), not in the dump.
2. **Hand the dump to the operator** out of band (or upload it to a GCS bucket the operator
   gives you). Never commit it to the repo.
3. **Know the owner id to stamp.** Rows will only be visible to their owner under RLS, and
   the migrated rows have no owner. The owner value is the deploying user's **resolved
   email, normalized** - the same `normalize_owner_email` rule the app applies at sign-in
   (trim + strip control/zero-width + NFKC + lowercase; see `iap-identity.md`), e.g.
   `dev@example.com`. **It must match exactly**: stamp `Dev.User@…` while the app
   resolves `dev.user@…` and RLS shows the user nothing (a real incident). Sanity check:
   sign into the deployed app once, create one row, and confirm its `owner_id` is that value.

## Operator-side (platform)

4. **Load via Cloud SQL GCS import** (server-side; no private-IP connectivity needed):
   ```bash
   gsutil cp app-data.sql gs://<PROJECT>-imports/app-data.sql
   gcloud sql import sql <SHARED_INSTANCE> gs://<PROJECT>-imports/app-data.sql \
     --database=<app-db-name>
   ```
   (Cloud SQL import grants its service account read on the object; if not, grant the
   instance SA `roles/storage.objectViewer` on the bucket.)
5. **Stamp ownership** so RLS attributes the rows to the deploying user. Run it the same
   way - a tiny SQL file imported via `gcloud sql import sql` (arbitrary SQL is allowed) -
   or paste it into Cloud SQL Studio. Working example:
   ```sql
   -- own-existing.sql  (repeat the UPDATE per user-owned table)
   -- break-glass first: writing rows you do not own needs app.break_glass, and FORCE RLS
   -- applies even to the admin connection, so without it the UPDATE matches zero rows.
   SET app.break_glass = 'on';
   UPDATE items SET owner_id = 'dev@example.com' WHERE owner_id IS NULL;
   ```
   (Use the deploying user's **normalized** email per `normalize_owner_email` in
   `iap-identity.md`. When loading per user, set `app.current_username` to that same
   normalized email before the insert so defaulted `owner_id`s match it exactly.)
   ```bash
   gcloud sql import sql <SHARED_INSTANCE> gs://<PROJECT>-imports/own-existing.sql --database=<app-db-name>
   ```
   You can also fold this UPDATE into the end of the data dump so it is one import.

## Verify

- Sign into the app as the owner - the migrated data appears.
- A different user does NOT see it (RLS still isolates).
- Row counts match the local source.

## Notes

- **Schema mismatch:** use `--data-only` so the dump does not fight the app-created schema.
  If a table only exists locally, create it on the deployed side first (the app's own
  migration), then import.
- **Foreign keys / order:** a single `pg_dump` handles ordering; if you hand-split files,
  load parents before children or disable triggers during import.
- **Large data:** Cloud SQL import streams from GCS; for very large dumps consider
  compressing (`.sql.gz` is supported) and importing off-peak.
- **Idempotency:** import into the empty app DB once; re-importing duplicates rows unless
  the dump uses upserts. Prefer a clean DB for the first load.
