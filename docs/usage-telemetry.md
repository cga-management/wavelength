# Per-app usage: aggregate-only

Design document, companion to [portal.md](portal.md) (the portal, architecture, and
visibility rules) and [cost-showback.md](cost-showback.md) (the cost half of the same
portfolio question).

## The policy stance

The portal answers "how many people use this app, how often?" - **counts, never who**.
Usage is stored and surfaced as aggregates only: no per-user activity view, no "last seen
by", no per-principal drill-down, at any privilege level including platform admin.

This has to be reconciled with the platform logging rule
([logging.md](../skills/onboard-app/references/logging.md)): shared logs carry no user
data. The reconciliation is explicit:

- The **inputs** are principal-level: computing "unique users" at all requires reading
  identities from the load balancer request logs and IAP data-access audit logs. There is
  no way to count distinct users without, at some instant, seeing which users.
- The pipeline reads those identities **transiently**, inside the collector job, for
  deduplication only. What it **stores** (in `usage_snapshots`) and what the portal
  **surfaces** are aggregates. No principal ever lands in a portal table, a portal
  screen, or a portal log line.

So the rule generalises cleanly: identities may transit the aggregation pipeline; they
may not rest in it.

## Metric definitions

Per app (joined by hostname, below):

- **Unique users, 48h / 7d / 30d** - distinct authenticated principals seen in the window.
- **Average users per day** - mean daily distinct principals over the window.
- **Requests served** - LB request count for the app's hostname over the window.
- **Uptime per day** (scale-to-zero) - the fraction of the day the app had at least one
  ready Cloud Run instance, from Cloud Run instance metrics. On a scale-to-zero platform
  this is a *demand* signal, not an availability SLO: near-zero uptime with zero users is
  the **archive-candidate signature** (nothing wakes it), while high uptime with near-zero
  users is its own smell (something keeps it warm that is not people).

## Data path on GCP

1. **Landing-zone log sink** routes the LB request logs and the IAP data-access audit
   logs to a BigQuery dataset. This is a platform-IaC prerequisite (a sink alongside the
   retention config in [`iac/gcp/monitoring.tf`](../iac/gcp/monitoring.tf)), delivered as
   a companion prerequisites change; like the billing export in
   [cost-showback.md](cost-showback.md), it accumulates only from enablement.
2. **The collector job** (scheduled, out-of-process, same dedicated scoped SA pattern as
   the cost collector - monitoring/BigQuery read only, never the shared app SA) aggregates
   by request **host**, maps host to slug, and upserts `usage_snapshots` rows. Identities
   are read inside the query for `COUNT(DISTINCT principal)` and discarded with the query.
3. **The portal renders the rows.** Layer 1 never touches a log.

**Join key: host to slug.** The LB logs know the requested hostname; the registry knows
each app's hostname (`apps.hostname`, unique - see the DDL in [portal.md](portal.md)).
That join is the entire coupling between the telemetry pipeline and the registry.

## `usage_snapshots` (Postgres, in `wl_admin`)

```sql
CREATE TABLE IF NOT EXISTS usage_snapshots (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug              text NOT NULL,           -- joins apps.slug (via hostname at collect time)
  window            text NOT NULL CHECK ("window" IN ('48h', '7d', '30d', 'day')),
  unique_users      integer NOT NULL,
  avg_users_per_day numeric,
  requests          bigint NOT NULL,
  uptime_pct        numeric,                 -- 0..100; 'day' windows for the uptime trend
  provider          text NOT NULL,           -- 'gcp', 'azure', 'aws'
  captured_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug, window, captured_at)
);
```

(`window` is a reserved word in some SQL dialects; quote it as above or rename to
`agg_window` if that grates.)

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
users see none. Aggregates are not PII, but "how much is this team's tool used" is still
not a broadcast.

## Other clouds: same rows, different collector

- **Azure**: Front Door / Application Gateway access logs plus Azure Monitor, aggregated
  by host, writing the same `usage_snapshots` rows with `provider = 'azure'`.
- **AWS**: ALB access logs plus CloudWatch, same rows, `provider = 'aws'`.

One collector job and one IaC stack per cloud; zero portal changes.
