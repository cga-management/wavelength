# One-time DB hardening (OPERATOR)

The app stack self-provisions its database and its own DB user (`<slug>_app`) on first
deploy, and the app works immediately - boot migrations run as that user, no operator
action needed. But Cloud SQL API-created users are members of `cloudsqlsuperuser` and
API-created databases are owned by it, so until this step runs, one compromised app's
credential could still reach other apps' databases - the hardening confines each app's
blast radius to its own database. Apps work fine without it: this is hardening, not a
blocker for deploy or verification.

## Per app (once, after its first deploy)

In Cloud SQL Studio, connect to the `<slug>` database as `wladmin` and run:

```sql
GRANT "<slug>_app" TO "wladmin";
ALTER DATABASE <slug> OWNER TO <slug>_app;
REASSIGN OWNED BY "wladmin" TO "<slug>_app";
REVOKE cloudsqlsuperuser FROM "<slug>_app";
```

Notes, in order:
- The `GRANT ... TO "wladmin"` line is REQUIRED first: ALTER/REASSIGN to a target role
  demand that the session user be a member of that role - `cloudsqlsuperuser` membership
  alone is not enough ("permission denied to reassign objects" without it). Keeping the
  membership afterwards is also what lets wladmin keep break-glass access to the app's
  tables once the app user is demoted.
- REASSIGN matters when any objects were created while connecting as wladmin (pre-wave-1
  apps, operator-applied schemas); on a purely self-provisioned app it is a no-op.
- Ownership moves BEFORE the revoke - after it, the user could not receive ownership.
- `<slug>` is the Postgres name, underscores not hyphens.

## Platform grant (once EVER, not per app)

Every app legitimately reads `wl_admin.platform_admins` to resolve platform-wide admins,
and apps no longer connect as the instance admin. In Cloud SQL Studio, connect to the
`wl_admin` database as `wladmin` and run:

```sql
GRANT CONNECT ON DATABASE wl_admin TO PUBLIC;
GRANT SELECT ON platform_admins TO PUBLIC;
```

Until this grant exists, an app's `platform_admins` lookup fails with permission denied;
the app should fall back to owner-only admin (see `shared-db-rls.md`).
