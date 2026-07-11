# Shared database + per-user isolation

Your app does not get its own database server. It gets **one database on the shared Cloud
SQL for PostgreSQL instance**, plus a Secret Manager secret holding the full connection
string. Because a locally-built app usually was not written for multiple users, you add
**username-driven row-level security (RLS)** so each signed-in user only sees their own
rows, plus an **admin** path: an entitled user can *read* across everyone's rows for
support, while *writing* another user's data is a separate, louder **break-glass** step.

## Connection

- Your app stack provisions its own slice on FIRST deploy (`app-stack/database.tf`): the
  `‹app›` database, a dedicated `‹app›_app` database user with a generated password, and
  the `‹app›-database-url` secret - no operator step. The DSN looks like:
  ```
  postgresql://<app>_app:<password>@<private-ip>:5432/<app>?sslmode=require&uselibpqcompat=true
  ```
  (`sslmode=require` = encrypt without verifying the private-IP cert.
  `&uselibpqcompat=true` is for **node/pg** only - drop it for psycopg/libpq.)
- Your Cloud Run service reads it as the `DATABASE_URL` env var, sourced from the secret -
  you never see or commit the value. The app SA already has `cloudsql.client` and
  `secretmanager.secretAccessor`; reachability is via Direct VPC egress (in the stack).
- The app connects as **its own user** (`‹app›_app`), not the instance admin. Its boot
  migrations run as that user, so the app's tables are owned by it. Cloud SQL caveat:
  API-created users are members of `cloudsqlsuperuser` and API-created databases are
  owned by it, so isolation from OTHER apps is partial until the operator runs the
  one-time hardening SQL (`db-hardening.md`) - the app works either way. Within your own
  data, RLS is the per-USER tenant boundary (FORCE RLS binds even the table owner) -
  implement it deliberately.

## Boot migrations (MANDATORY)

The schema AND the RLS below are applied by the app itself at startup - idempotent SQL
run on every boot (the apply-at-boot pattern). Migration files for an operator to paste
into Cloud SQL Studio are NOT an acceptable deliverable: the first deploy creates the
database seconds before the app boots, so the app must come up on an EMPTY database with
no operator action, and a redeploy onto a fresh slice must self-heal.

- Guard everything: `CREATE TABLE IF NOT EXISTS`, `ALTER TABLE ... ADD COLUMN IF NOT
  EXISTS`, indexes with `IF NOT EXISTS`; `CREATE POLICY` has no `IF NOT EXISTS`, so use
  `DROP POLICY IF EXISTS` + `CREATE POLICY` (or a catalog check).
- Retry with backoff (e.g. 5 attempts, a few seconds apart) - on the very first boot the
  freshly created database can lag the service by a few seconds.
- It must be a no-op on an already-migrated database - it runs on EVERY cold start.
- **Expand-only, always.** Deploys are zero-downtime: Cloud Run boots the NEW revision
  (which runs these migrations against the live shared database) while the OLD revision
  is still serving traffic, and cuts over only when the new one is Ready. So for a
  window of seconds to minutes - or indefinitely, if the new revision fails after the
  migration ran - the previous code runs against the migrated schema. Migrations must
  therefore only ADD (nullable columns, new tables, new indexes); never DROP, RENAME,
  or change the meaning of anything the currently-serving code still reads. Remove old
  columns in a LATER release, after no serving revision references them
  (expand/contract). A `DROP COLUMN` shipped in the same release as the code that stops
  using it gives every in-flight request on the old revision a live schema error.

## The two shared/lookup databases you can read

- **`wl_admin`** - the shared admin registry. It has a `platform_admins` table listing
  platform-wide admins. Your app resolves a user as **admin** if they are in
  `platform_admins` OR are the app **owner** (the deploying dev). You read `wl_admin` on
  the same instance/private-IP, connecting as your own `‹app›_app` user. Plainly: this
  read only works after the one-time PLATFORM grant (`GRANT CONNECT ON DATABASE wl_admin
  TO PUBLIC; GRANT SELECT ON platform_admins TO PUBLIC;` - see `db-hardening.md`) has been
  run. If the lookup fails with permission denied, or the table is empty/absent, fall
  back to owner-only admin and tell the operator.
- Your own `‹app›` database holds the app's tables.

## Ownership + RLS migration (Postgres)

Add an owner column to every user-owned table, enable RLS, and gate by per-request session
settings. `app.current_username` is set from the IAP identity (`iap-identity.md`). Admin
access is split along the **read/write line** by two flags - `app.admin_mode` (read across
users + write shared *reference* data) and `app.break_glass` (write any user's *owned*
rows) - see *Admin is a MODE* below for how they are set.

```sql
-- Applied BY THE APP at startup (boot migration) - idempotent, safe on every boot.
-- (Your tables themselves are created just before this, with CREATE TABLE IF NOT EXISTS.)

-- 1) owner column on each user-owned table (backfill existing rows to the owner/dev id)
ALTER TABLE items ADD COLUMN IF NOT EXISTS owner_id text NOT NULL DEFAULT current_setting('app.current_username', true);

-- 2) enable + FORCE RLS (FORCE so it applies even to the table owner - your app's own
--    DB user, which created the table). Both statements are idempotent.
ALTER TABLE items ENABLE ROW LEVEL SECURITY;
ALTER TABLE items FORCE ROW LEVEL SECURITY;

-- 3) TWO policies, split along the read/write line. Permissive policies OR together, so
--    admin READ widens visibility while WRITE stays narrow. CREATE POLICY has no
--    IF NOT EXISTS - drop-and-recreate keeps the migration idempotent.
DROP POLICY IF EXISTS items_owner      ON items;
DROP POLICY IF EXISTS items_admin_read ON items;

-- base: read+write your OWN rows; break-glass widens WRITE (and read) to ALL rows.
CREATE POLICY items_owner ON items FOR ALL
  USING      (owner_id = current_setting('app.current_username', true)
              OR current_setting('app.break_glass', true) = 'on')
  WITH CHECK (owner_id = current_setting('app.current_username', true)
              OR current_setting('app.break_glass', true) = 'on');

-- everyday admin: read-only visibility across ALL users (cannot write others' rows).
CREATE POLICY items_admin_read ON items FOR SELECT
  USING (current_setting('app.admin_mode', true) = 'on');
```

Net effect per command:

- **SELECT** - allowed if you own the row **OR** `admin_mode` **OR** `break_glass`.
- **INSERT / UPDATE / DELETE** - allowed if you own the row **OR** `break_glass` only.

So an everyday admin can **look but not touch** other users' data; changing it is a
deliberate break-glass act. Repeat the two-policy block per user-owned table.

**Shared reference/lookup tables** (config, taxonomies - data the app curates, not owned by
any user) invert the model: everyone reads, only an everyday admin writes.

```sql
ALTER TABLE refdata ENABLE ROW LEVEL SECURITY;
ALTER TABLE refdata FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS refdata_read  ON refdata;
DROP POLICY IF EXISTS refdata_write ON refdata;
CREATE POLICY refdata_read  ON refdata FOR SELECT USING (true);          -- anyone may read
CREATE POLICY refdata_write ON refdata FOR ALL
  USING      (current_setting('app.admin_mode', true) = 'on')            -- only admin_mode writes
  WITH CHECK (current_setting('app.admin_mode', true) = 'on');
```

(A purely static lookup table nobody edits at runtime can simply be left without RLS.)

## Setting the session context per request

Set the GUCs at the start of each request/transaction, from the verified identity. Use
`SET LOCAL` inside a transaction so the setting is scoped to that request only and never
leaks across pooled connections.

```python
# app/db.py  (FastAPI + SQLAlchemy sketch)
from sqlalchemy import text

def apply_rls_context(conn, username: str, admin_mode: bool, break_glass: bool):
    # SET LOCAL is transaction-scoped; safe with connection pooling.
    conn.execute(text("SET LOCAL app.current_username = :u"), {"u": username})
    conn.execute(text("SET LOCAL app.admin_mode = :a"), {"a": "on" if admin_mode else "off"})
    conn.execute(text("SET LOCAL app.break_glass = :b"), {"b": "on" if break_glass else "off"})

# per request: open a transaction, apply context from CurrentUser, then run queries.
# admin_mode/break_glass are 'on' ONLY when the user is entitled AND has explicitly
# activated that mode this session (see below) - never straight from the entitlement flag.
```

```python
# app/admin.py  -  resolve admin ENTITLEMENT from platform_admins OR owner
import os
def is_admin_entitled(email: str | None) -> bool:
    # `email` arrives already normalized (normalize_owner_email, see iap-identity.md).
    # Normalize APP_OWNER_EMAIL the same way so the comparison is apples-to-apples.
    if email and email == normalize_owner_email(os.environ.get("APP_OWNER_EMAIL", "")):
        return True                     # the deploying dev (owner)
    # SELECT 1 FROM wl_admin.platform_admins WHERE lower(email) = lower(:email)
    return _in_platform_admins(email)   # query the wl_admin database

def is_break_glass_entitled(email: str | None) -> bool:
    # Break-glass (write across users) is limited to the app OWNER or a PLATFORM admin.
    # Same set as admin entitlement here; tighten per your platform policy if needed.
    return is_admin_entitled(email)
```

Set `APP_OWNER_EMAIL` (the deploying dev) as a plain env var in the stack so the owner is
always admin even before `platform_admins` is seeded.

## Admin is a MODE, not a view - and WRITE is a separate, louder tier

Both admin flags are **default OFF** and set to `'on'` only for a user who is **entitled
AND has explicitly activated** that mode this session. The entitlement flag alone never
sets a GUC. This keeps an owner's daily use normal - their lists show their own rows, and
a mis-click cannot touch anyone else's data.

Two independent flags:

- **`app.admin_mode`** - everyday admin. Read ALL users' rows (support/troubleshooting)
  and write SHARED REFERENCE data. Does **not** let you write another user's owned rows.
- **`app.break_glass`** - data surgery. Additionally write ANY user's owned rows (full row
  bypass). Rare, explicit, audited; only meaningful with `admin_mode` also on.

Entitlement vs active:

- **Entitled (admin_mode)** = owner or in `platform_admins`. Grants the OPTION.
- **Entitled (break_glass)** = owner or platform admin (per platform policy).
- **Active** = the user explicitly switched that mode ON this session. Default OFF every
  new session.

Implementation:

- `GET /api/me` returns `{ email, isAdmin: <entitled>, adminMode: <active>, breakGlass: <active> }`.
- `POST /api/admin-mode { enabled }` - 403 unless entitled; persist in an httpOnly, Secure
  cookie (or server session). **Default OFF on every new session.**
- `POST /api/break-glass { enabled, reason }` - 403 unless break-glass-entitled; **requires
  a non-empty `reason`**; **emit a structured audit log line** (who / when / why, no row
  payload - see `logging.md`). Keep it session-scoped and default OFF.
- UI: `admin_mode` shows a persistent banner ("ADMIN MODE - viewing all users' data
  (read-only)"); `break_glass` shows an even louder banner ("BREAK-GLASS - writing across
  all users") with one-click exit. Ordinary users see nothing new.
- Enforce server-side (the RLS GUCs are the boundary); the toggles are presentation only.

**Writing a row on behalf of another user (break-glass):** always set `owner_id` to the
TARGET user **explicitly**. Do not rely on the `DEFAULT current_setting('app.current_username')`
- that stamps the admin's own id and orphans the row from its real owner.

> **Migrating from a single `app.is_admin` flag?** Earlier versions of this pattern used one
> GUC that bypassed RLS for read *and* write. To adopt the split: replace the single
> `items_owner` policy with the two policies above, swap `app.is_admin` for `app.admin_mode`
> in the everyday-admin read path, and gate all cross-user WRITES on the new
> `app.break_glass` flag. Because RLS is applied at boot (idempotent, drop-and-recreate),
> the next deploy converges the policies with no manual DB step.

## Rules

- The owner id you store is the user's **resolved email, normalized** (`normalize_owner_email`
  - trim + strip control/zero-width + NFKC + lowercase; see `iap-identity.md` for exactly
  where it comes from and the helper). It is the platform's identity key
  everywhere: `platform_admins`, the app owner, and your rows all match on it.
  Working example: `owner_id = 'dev@example.com'`.
- Never disable RLS to "make a query work" - add/adjust a policy instead.
- Do not create a separate DB server, and do not expose the DB publicly - it is private-IP
  only by design.
