# Per-app cost: showback, not chargeback

Design document, companion to [portal.md](portal.md) (which defines the portal, the
three-layer architecture, and who sees what) and [usage-telemetry.md](usage-telemetry.md)
(the other half of the "does this app earn its place?" question).

## Purpose

Platform owners need to see what the portfolio costs and whether each app justifies its
share. That is the whole scope:

- **Showback, never chargeback.** Numbers are shown to app admins and platform admins;
  nobody is billed back, no budgets are enforced, no deploy is blocked on spend.
- **Cost is confirmation, not trigger.** The archive decision is driven by usage
  ([usage-telemetry.md](usage-telemetry.md)); cost tells you what the unused thing is
  costing while you decide. On a scale-to-zero platform an idle app's runtime cost is
  near-nil anyway - archiving is sprawl control, and the cost panel keeps the decision
  honest rather than urgent.

## The honesty model: three tiers on the card

Cloud bills do not decompose cleanly per app, and pretending otherwise produces numbers
people quote and then distrust. Each app card therefore shows cost in three explicitly
labelled tiers, never a single merged figure:

1. **Attributed** - real billing rows. On GCP these are BigQuery billing-export rows
   carrying the app's `app=<slug>` label: the app's Cloud Run service (label on the
   service AND the revision template - the companion prerequisites change adds this to
   [`app-stack/run.tf`](../skills/onboard-app/references/app-stack/run.tf)) and any
   app-labelled storage. This tier is fact.

   **Gross, not net-of-credits.** All tiers show gross consumption; account credits
   (free trial, promotional) are NOT subtracted per app. A credit nets every row to a
   meaningless 0.00 for as long as it lasts - observed live on a credited account: a
   portal full of zeros that reads as "no cost data" - while the showback question is
   what an app CONSUMES. Credits appear as their own explicit line in the portfolio
   rollup (like the unattributed remainder), so the rollup still reconciles to the
   actual invoice: sum(gross) + credits + remainder = the bill.
2. **Apportioned** - the app's share of the shared floor, always labelled **estimated**:
   - **Cloud SQL** (the shared instance): split by each app's `pg_database_size()` share.
     This is a stated heuristic - database size is a proxy for load, not a measurement of
     it - but it is stable, cheap to compute, and hard to game.
   - **Load balancer, egress, Secret Manager, Artifact Registry**: shown as a single
     **platform overhead** line, optionally divided by app count. These do not
     meaningfully attribute per app and the model does not pretend they do.
3. **AI spend** - a separate panel with a **different source of truth**: the model
   gateway's own usage log, not the cloud bill. Each app gets a per-app gateway key at
   onboarding; the gateway's request log joins key to slug, giving per-app token/model
   spend directly. Do not try to carve AI spend out of the cloud bill - the gateway
   already knows, per request, which app spent what.

The three tiers stay visually distinct on the card. "Attributed" may be quoted;
"apportioned" carries its heuristic in the label; AI spend reconciles to the gateway, not
the bill.

## Prerequisites (platform-side, done at standup/onboarding)

These are the enablers the collector depends on; they are delivered as a companion
prerequisites change to the platform IaC and app-stack, not by this document:

- **`app=<slug>` labels on Cloud Run** - on both the service and the revision template
  (billing rows follow the revision's labels), added to
  [`app-stack/run.tf`](../skills/onboard-app/references/app-stack/run.tf) by the
  companion change. Labels are **not retroactive**: cost rows only carry the label from
  the next redeploy onward.
- **BigQuery detailed billing export**, enabled at platform standup. This is a manual,
  console-only step (the Billing API does not expose it), and the export **accumulates
  only from enablement** - there is no backfill, which is why it belongs in the standup
  runbook rather than "when we get round to cost".
- **Per-app gateway keys** minted at onboarding, so the AI-spend join (key to slug)
  exists from the app's first request.

## `cost_snapshots` (Postgres, in `wl_admin`)

```sql
CREATE TABLE IF NOT EXISTS cost_snapshots (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug         text NOT NULL,               -- joins apps.slug
  period_start date NOT NULL,
  period_end   date NOT NULL,
  attributed   jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"cloud_run": 1.23, "storage": 0.10}
  apportioned  jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"cloud_sql": 0.85, "platform_overhead": 0.40}
  ai_spend     jsonb NOT NULL DEFAULT '{}'::jsonb,  -- {"total": 4.20, "by_model": {...}}
  currency     text NOT NULL,
  provider     text NOT NULL,               -- 'gcp', 'azure', 'aws'
  captured_at  timestamptz NOT NULL DEFAULT now(),
  UNIQUE (slug, period_start, period_end)
);
```

The table is the contract ([portal.md](portal.md), layer 2): the portal renders whatever
rows are here and knows nothing about where they came from.

## The collector

A scheduled, out-of-process job per cloud - on GCP, Cloud Scheduler triggering a job that:

1. Queries the billing export in BigQuery for label-attributed rows per slug.
2. Computes the Cloud SQL split from `pg_database_size()` shares and the shared-floor
   overhead line.
3. Queries the gateway's usage log per gateway key, mapping key to slug.
4. **Upserts** one row per `(slug, period)` - idempotent, so a re-run after a partial
   failure converges instead of double-counting.

**It runs under a dedicated, scoped service account** with billing/BigQuery viewer only -
**never** the shared app runtime SA. The shared SA is inherited by every tenant app on the
platform; a billing-read grant placed on it silently cascades to all of them, which is
precisely the blast-radius mistake the platform's least-privilege stance exists to
prevent. One collector SA, one job, one IaC stack per cloud.

**The portfolio rollup must reconcile to the bill.** The portfolio view (platform admins
only) is the sum of per-app rows **plus an explicit "unattributed" remainder line** -
everything in the billing export that no label or heuristic claimed. The total therefore
always equals the invoice; a rollup that quietly drops the unlabelled remainder teaches
people the numbers are wrong, and a growing remainder is itself the signal that labels are
missing somewhere.

## Other clouds: same rows, different collector

Nothing in the portal changes. The named swap points:

- **Azure**: a collector against Cost Management (tag-based attribution), writing the
  same `cost_snapshots` rows with `provider = 'azure'`.
- **AWS**: a collector against the Cost and Usage Report (CUR), same rows,
  `provider = 'aws'`.

## Visibility

Per the authorization table in [portal.md](portal.md): app admins see their own app's
cost panel; platform admins see every app plus the portfolio rollup; ordinary users see
no cost data at all. Cost figures are aggregates about infrastructure, not user data, but
they are still an operational detail the platform does not broadcast.
