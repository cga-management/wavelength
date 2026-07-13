// Cost collector (docs/cost-showback.md). Showback, never chargeback. Three explicit
// tiers per app, never a single merged figure:
//   1. Attributed  - real billing rows carrying app=<slug> (fact).
//   2. Apportioned - the shared floor, labelled estimated: Cloud SQL split by each app's
//      pg_database_size() share, plus a single platform_overhead line (LB, egress, Secret
//      Manager, Artifact Registry) divided by app count.
//   3. AI spend    - gateway usage log. Left as {} for now (gateway not deployed).
//
// The portfolio must reconcile to the bill: a synthetic '__unattributed__' row carries
// everything no label or heuristic claimed, so the sum of all rows equals the invoice.
//
// Idempotent: UPSERT one row per (slug, period) keyed on the current month, so a re-run
// after a partial failure converges instead of double-counting.

import { pool } from "../db.js";
import { log } from "../logger.js";
import { findTables, query, fqTable } from "./bq.js";

// Service.description buckets for the apportioned/overhead split. These are the GCP
// billing service names; unmatched shared rows fall into the unattributed remainder.
const CLOUD_SQL_SERVICE = "Cloud SQL";
const OVERHEAD_SERVICES = ["Networking", "Secret Manager", "Artifact Registry", "Cloud DNS", "Compute Engine"];

// System databases never billed to an app.
const SYSTEM_DBS = new Set(["template0", "template1", "postgres", "cloudsqladmin"]);

function monthWindow(now = new Date()) {
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const end = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
  return { start, end };
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}

// dbname for a slug: Postgres identifiers use underscores, so a hyphenated slug maps to
// underscores (mirrors app-stack/database.tf).
function dbNameForSlug(slug) {
  return slug.replace(/-/g, "_");
}

export async function runCostCollector() {
  const tables = await findTables("gcp_billing_export%");
  if (tables.length === 0) {
    log.info("no source data yet: billing export table absent", { collector: "cost" });
    return;
  }
  // Prefer whichever export table is FRESHEST, breaking ties toward the detailed
  // (resource-level) one. The detailed and standard exports are independent delivery
  // pipelines and either can stall (observed live: detailed wedged for days while the
  // billing console showed the data); preferring detailed unconditionally would keep
  // reading the stale table forever.
  let table = tables[0];
  if (tables.length > 1) {
    const freshness = [];
    for (const t of tables) {
      const [r] = await query(`SELECT UNIX_SECONDS(MAX(export_time)) AS ts FROM ${fqTable(t)}`);
      freshness.push({ t, ts: Number((r && r.ts) || 0), detailed: t.includes("resource") ? 1 : 0 });
    }
    freshness.sort((a, b) => b.ts - a.ts || b.detailed - a.detailed);
    table = freshness[0].t;
    log.info("billing export table chosen by freshness", { collector: "cost", table, candidates: freshness.length });
  }
  const { start, end } = monthWindow();

  const rows = await query(
    `SELECT
       (SELECT value FROM UNNEST(labels) WHERE key = 'app') AS app,
       service.description AS service,
       SUM(cost) AS gross,
       SUM((SELECT IFNULL(SUM(c.amount), 0) FROM UNNEST(credits) c)) AS credits,
       ANY_VALUE(currency) AS currency
     FROM ${fqTable(table)}
     WHERE usage_start_time >= @start AND usage_start_time < @end
     GROUP BY app, service`,
    { start: start.toISOString(), end: end.toISOString() },
  );

  if (rows.length === 0) {
    log.info("no source data yet: billing export has no rows in window", { collector: "cost", table });
    return;
  }

  const currency = (rows.find((r) => r.currency) || {}).currency || "GBP";

  // Bucket every billing row into exactly one tier so the rollup reconciles. Tiers are
  // GROSS consumption, not net-of-credits: an account credit (free trial, promo) nets
  // every app to a meaningless 0.00 while the credit lasts, and showback asks what an
  // app CONSUMES. Credits become their own portfolio line (__credits__ below) so the
  // rollup still reconciles to the actual invoice: sum(gross) + credits + remainder.
  const attributed = {}; // slug -> { service -> gross }
  let cloudSqlTotal = 0;
  let overheadTotal = 0;
  let remainder = 0;
  let grandTotal = 0;
  let creditsTotal = 0;

  for (const r of rows) {
    const gross = Number(r.gross || 0);
    grandTotal += gross;
    creditsTotal += Number(r.credits || 0);
    if (r.app) {
      attributed[r.app] = attributed[r.app] || {};
      const key = costKey(r.service);
      attributed[r.app][key] = (attributed[r.app][key] || 0) + gross;
    } else if (r.service === CLOUD_SQL_SERVICE) {
      cloudSqlTotal += gross;
    } else if (OVERHEAD_SERVICES.includes(r.service)) {
      overheadTotal += gross;
    } else {
      remainder += gross;
    }
  }

  // Apportion Cloud SQL by each app's pg_database_size share.
  const dbSizes = await databaseSizes();
  const { rows: appRows } = await pool.query(`SELECT slug FROM apps WHERE slug <> '__unattributed__'`);
  const appSlugs = appRows.map((a) => a.slug);
  const sizeBySlug = {};
  let totalSize = 0;
  for (const slug of appSlugs) {
    const bytes = dbSizes[dbNameForSlug(slug)] || 0;
    sizeBySlug[slug] = bytes;
    totalSize += bytes;
  }
  const appCount = Math.max(appSlugs.length, 1);

  const { start: ps, end: pe } = monthWindow();
  let written = 0;
  for (const slug of appSlugs) {
    const share = totalSize > 0 ? sizeBySlug[slug] / totalSize : 0;
    const apportioned = {
      cloud_sql: round(cloudSqlTotal * share),
      platform_overhead: round(overheadTotal / appCount),
    };
    await upsertCost({
      slug, periodStart: iso(ps), periodEnd: iso(pe),
      attributed: roundObj(attributed[slug] || {}),
      apportioned, aiSpend: {}, currency,
    });
    written++;
  }

  // The explicit unattributed remainder line so the portfolio reconciles to the invoice.
  await upsertCost({
    slug: "__unattributed__", periodStart: iso(ps), periodEnd: iso(pe),
    attributed: { remainder: round(remainder) }, apportioned: {}, aiSpend: {}, currency,
  });

  // Credits as their own portfolio line (negative). Kept out of per-app tiers so app
  // figures stay meaningful consumption numbers while an account credit runs.
  await upsertCost({
    slug: "__credits__", periodStart: iso(ps), periodEnd: iso(pe),
    attributed: { credits_applied: round(creditsTotal) }, apportioned: {}, aiSpend: {}, currency,
  });

  log.info("cost snapshots written", {
    collector: "cost", apps: written, table,
    grossTotal: round(grandTotal), creditsTotal: round(creditsTotal),
    cloudSqlTotal: round(cloudSqlTotal), overheadTotal: round(overheadTotal),
    remainder: round(remainder),
  });
}

function costKey(service) {
  if (!service) return "other";
  if (service.includes("Cloud Run")) return "cloud_run";
  if (service.includes("Storage")) return "storage";
  return service.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "");
}

async function databaseSizes() {
  const { rows } = await pool.query(
    `SELECT datname, pg_database_size(datname) AS bytes FROM pg_database WHERE datistemplate = false`,
  );
  const out = {};
  for (const r of rows) {
    if (!SYSTEM_DBS.has(r.datname)) out[r.datname] = Number(r.bytes);
  }
  return out;
}

async function upsertCost({ slug, periodStart, periodEnd, attributed, apportioned, aiSpend, currency }) {
  await pool.query(
    `INSERT INTO cost_snapshots (slug, period_start, period_end, attributed, apportioned, ai_spend, currency, provider, captured_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'gcp', now())
     ON CONFLICT (slug, period_start, period_end)
     DO UPDATE SET attributed = EXCLUDED.attributed, apportioned = EXCLUDED.apportioned,
                   ai_spend = EXCLUDED.ai_spend, currency = EXCLUDED.currency, captured_at = now()`,
    [slug, periodStart, periodEnd, JSON.stringify(attributed), JSON.stringify(apportioned), JSON.stringify(aiSpend), currency],
  );
}

function round(n) {
  return Math.round(Number(n) * 100) / 100;
}
function roundObj(o) {
  const out = {};
  for (const [k, v] of Object.entries(o)) out[k] = round(v);
  return out;
}
