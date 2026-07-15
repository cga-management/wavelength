# Per-app usage: aggregate-by-default, with one posture switch

Design document, companion to [portal.md](portal.md) (the portal, architecture, and
visibility rules) and [cost-showback.md](cost-showback.md) (the cost half of the same
portfolio question).

## The policy stance

The portal answers "how many people use this app, how often?" - and, if the platform
chooses, "who?". Usage is **aggregate-by-default with one explicit posture choice**,
made once per platform on the landing zone:

- **`usage_identity_mode = "email"`** (the default): the telemetry pipeline carries the
  user's normalized email, and the portal can additionally show **who uses each app** -
  a "Users (30d)" list on the app detail page, visible ONLY to that app's admins and
  platform admins (the same `canSeeCostUsage` gate as the counts). The rationale for
  defaulting here: on a small platform, every audience with log or dataset access - the
  platform operators, and an app's own admins via the portal's log panel or their own
  database's admin mode - can already see these emails through stronger paths. Hashing
  would add plumbing without removing an exposure.
- **`usage_identity_mode = "hashed"`**: the pipeline carries
  `HMAC-SHA256(platform salt, normalized email)`, hex-truncated - a keyed pseudonymous
  token, stable per user, meaningless without the salt (a Secret Manager secret owned by
  the landing zone). Counts only; **no user list exists anywhere** - not in BigQuery
  queries' output, not in `usage_snapshots`, not on a portal screen. This is the
  stricter posture, and upgrading to it is **one variable flip** on the landing zone
  plus app redeploys (the salt is provisioned unconditionally, so no resource dance).

Both modes share a **retention guard**: the telemetry dataset has 90-day partition
expiration, so per-user rows - emails or hashes - age out and the dataset never becomes
a long-lived activity ledger. The portal's aggregated snapshots keep the history that
matters. (This is also cost hygiene.)

There is still no per-user activity view, no "last seen by", no per-principal
drill-down, at any privilege level: the WHO list is membership over a window, not a
timeline.

This has to be reconciled with the platform logging rule
([logging.md](../skills/onboard-app/references/logging.md)): shared logs carry no user
data. The reconciliation is explicit: the `wl.auth` line (below) is the ONE sanctioned
place a user identifier goes to shared logs, it carries exactly what the platform's
`usage_identity_mode` dictates, and it is routed to a retention-bounded dataset.
Everywhere else the rule stands unchanged (log the opaque `sub`, never the email).

## Metric definitions

Per app (joined as described below):

- **Unique users, 48h / 7d / 30d** - distinct `wl.auth` tokens seen in the window
  (emails or hashes, per the platform mode; either way one token = one user).
- **Average users per day** - mean daily distinct users over the window.
- **Requests served** - LB request count for the app's hostname over the window.
- **Uptime per day** (scale-to-zero) - the fraction of the day the app had at least one
  ready Cloud Run instance, from Cloud Run instance metrics. On a scale-to-zero platform
  this is a *demand* signal, not an availability SLO: near-zero uptime with zero users is
  the **archive-candidate signature** (nothing wakes it), while high uptime with near-zero
  users is its own smell (something keeps it warm that is not people).
- **Users (30d)** - email mode only: the distinct user list for the 30d window, capped
  at 200 entries, alphabetical. Null in hashed mode.

## Data path on GCP

1. **Apps emit the unique-user signal.** Workforce-federated IAP emits NO per-request
   data-access audit entries (verified live on this platform shape), and neither LB nor
   Cloud Run request logs carry identity - so the apps themselves are the source. Each
   app's identity middleware ([iap-identity.md](../skills/onboard-app/references/iap-identity.md),
   "The usage-telemetry auth line") emits one structured line per user per day after
   successful verification:

   ```json
   {"severity": "INFO", "message": "authenticated", "event": "wl.auth", "user": "<token>"}
   ```

   `user` is the normalized email (email mode) or its keyed hash (hashed mode); the mode
   and salt arrive as the `USAGE_IDENTITY_MODE` / `USAGE_HASH_SALT` envs, wired by the
   app stack from landing-zone outputs. Telemetry fails open: a missing salt in hashed
   mode falls back to email mode with a startup warning, and the emit never blocks
   authentication. NOTE: apps deployed before this mechanism emit nothing until rebuilt
   and redeployed - their unique-user counts read as honest zeros, while requests and
   uptime are unaffected.

2. **The landing-zone log sink routes three signals** to one BigQuery dataset
   ([`iac/gcp/telemetry.tf`](../iac/gcp/telemetry.tf), which also sets the 90-day
   partition expiration): the external HTTPS LB request logs (the `iap-lb` module
   enables backend request logging - OFF by default on GCP - so there are entries to
   route), the IAP data-access audit entries (empty under workforce federation, kept for
   plain Google-identity adopters), and ONLY the `wl.auth` app lines (matched on
   `jsonPayload.event`, never general app stdout). Like the billing export in
   [cost-showback.md](cost-showback.md), a sink accumulates only from enablement.

3. **The collector job** (scheduled, out-of-process, same dedicated scoped SA pattern as
   the cost collector - monitoring/BigQuery read only, never the shared app SA)
   aggregates requests by host and unique users by Cloud Run service inside BigQuery,
   maps both to slugs, and upserts `usage_snapshots` rows. In email mode it also stores
   the 30d user list with the 30d row; in hashed mode identities cannot be recovered and
   only counts leave the query.

4. **The portal renders the rows.** Layer 1 never touches a log. The Users (30d) list
   renders only when the row carries one - so a hashed-mode (or pre-upgrade) instance
   simply never shows it.

**Join keys.** Requests join **host to slug**: the LB logs know the requested hostname;
the registry knows each app's hostname (`apps.hostname`, unique - see the DDL in
[portal.md](portal.md)). Auth lines join **Cloud Run service name to slug**: service
names follow `<workload>-<slug>-<environment>`, the same convention the uptime path
uses, and the service name is server-derived (resource labels), never app-supplied.

## `usage_snapshots` (Postgres, in `wl_admin`)

```sql
CREATE TABLE IF NOT EXISTS usage_snapshots (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug              text NOT NULL,           -- joins apps.slug (at collect time)
  window            text NOT NULL CHECK ("window" IN ('48h', '7d', '30d', 'day')),
  unique_users      integer NOT NULL,
  avg_users_per_day numeric,
  requests          bigint NOT NULL,
  uptime_pct        numeric,                 -- 0..100; 'day' windows for the uptime trend
  users             jsonb,                   -- 30d window, email mode only; else null
  provider          text NOT NULL,           -- 'gcp', 'azure', 'aws'
  captured_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug, window, captured_at)
);
```

(`window` is a reserved word in some SQL dialects; quote it as above or rename to
`agg_window` if that grates. The `users` column arrived as an expand-only boot
migration, per the portal's own schema rule.)

As with cost, **the table is the contract** ([portal.md](portal.md), layer 2): the portal
renders rows and never learns how they were computed.

## Usage drives archive

The portfolio view (platform admins) sorts by staleness: zero unique users across 30d,
near-zero uptime, requests flat. Archiving - with its required recorded reason
([portal.md](portal.md), lifecycle) - is the **sanctioned response** to sustained
no-usage. That is the point of collecting usage at all: the platform owners' question is
"which apps earn their place", usage answers it, and
[cost-showback.md](cost-showback.md) supplies the confirmation number for the archive
reason. Without this loop, a self-service platform only ever accretes apps.

## Visibility

Same as cost ([portal.md](portal.md) authorization table): app admins see their own
app's usage; platform admins see every app and the portfolio staleness view; ordinary
users see none. The Users (30d) list (email mode) sits behind exactly the same gate -
an app's own admins and platform admins, nobody else. Counts are not PII, but "how much
is this team's tool used" is still not a broadcast - and "who uses it" certainly is not.

## Other clouds: same rows, different collector

- **Azure**: Front Door / Application Gateway access logs plus Azure Monitor for
  requests and uptime, the same app-emitted `wl.auth` lines for unique users, writing
  the same `usage_snapshots` rows with `provider = 'azure'`.
- **AWS**: ALB access logs plus CloudWatch, same rows, `provider = 'aws'`.

One collector job and one IaC stack per cloud; zero portal changes. The `wl.auth`
contract is cloud-agnostic by construction - any IdP, any log transport that can route
one JSON line.
