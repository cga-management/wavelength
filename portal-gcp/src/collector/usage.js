// Usage collector (docs/usage-telemetry.md). Aggregate-by-default, with one platform
// posture switch (USAGE_IDENTITY_MODE, set on the landing zone): unique users come from
// the apps' own wl.auth lines (one structured line per user per day from each app's
// identity middleware - workforce-federated IAP emits no per-request audit entries, so
// the apps ARE the source). In "email" mode the collector also stores each app's
// distinct 30d user list (capped, alphabetical) so the portal can show WHO uses an app
// to that app's admins and platform admins. In "hashed" mode the tokens are keyed
// pseudonymous hashes: counts only, no list is ever stored.
//
// Join keys: requests join by host -> slug (the LB logs know the requested hostname;
// apps.hostname is unique). wl.auth lines join by Cloud Run service name -> slug
// (service names follow ${WORKLOAD}-<slug>-${ENVIRONMENT}, same convention the uptime
// path uses).
//
// Metrics per app, per window (48h/7d/30d):
//   unique_users      distinct wl.auth tokens (emails or hashes per the platform mode)
//   avg_users_per_day mean daily distinct users over the window
//   requests          LB request count for the app's hostname
//   uptime_pct        fraction of the window a Cloud Run instance was ready (demand signal)
//   users             30d window only, email mode only: the distinct user list (jsonb)
//
// Empty/missing sources are handled gracefully: a log sink accumulates only from
// enablement, so on a fresh platform the tables do not exist yet - log a structured
// "no source data yet" and exit 0.

import { pool } from "../db.js";
import { log } from "../logger.js";
import { findTables, query, fqTable } from "./bq.js";
import { MetricServiceClient } from "@google-cloud/monitoring";

const WORKLOAD = process.env.GCP_WORKLOAD || "wl";
const ENVIRONMENT = process.env.GCP_ENVIRONMENT || "platform";
const PROJECT_ID = process.env.GCP_PROJECT_ID;
// "email" (default) or "hashed" - the landing zone's usage_identity_mode. Only gates
// whether the 30d user list is stored; the tokens arrive pre-shaped in the log lines.
const USAGE_IDENTITY_MODE = process.env.USAGE_IDENTITY_MODE || "email";

const WINDOWS = [
  { name: "48h", days: 2 },
  { name: "7d", days: 7 },
  { name: "30d", days: 30 },
];

// One partitioned table per log type is the contract (see the guard comment at the
// call site). More than one match means the sink is writing date shards; refuse the
// silent single-day undercount and say what to fix.
function pickSingleTable(tables, kind) {
  if (tables.length === 0) return null;
  if (tables.length > 1) {
    log.warning("multiple sink tables for one log type - sink is date-sharded, not partitioned", {
      collector: "usage", kind, count: tables.length,
      fix: "recreate the telemetry sink with bigquery_options.use_partitioned_tables = true (iac/gcp/telemetry.tf)",
    });
  }
  return tables[tables.length - 1];
}

export async function runUsageCollector() {
  const { rows: apps } = await pool.query(
    `SELECT slug, hostname FROM apps WHERE hostname IS NOT NULL AND slug <> '__unattributed__'`,
  );
  if (apps.length === 0) {
    log.info("no apps registered; nothing to aggregate", { collector: "usage" });
    return;
  }

  const [reqTables, authTables] = await Promise.all([
    findTables("requests%"), // external HTTPS LB request logs
    findTables("run_googleapis_com_stdout%"), // the apps' wl.auth usage lines
  ]);
  // The landing-zone sink sets bigquery_options.use_partitioned_tables = true, so each
  // log type is ONE day-partitioned table (verified live: a single `requests` table,
  // DAY-partitioned on `timestamp`) and window queries scan the full window with
  // partition pruning. If a sink were recreated WITHOUT that option, BigQuery writes
  // date-sharded requests_YYYYMMDD tables instead - and taking the lexically-last one
  // would silently scope every window to a single day (template issue #46). Guard it.
  const reqTable = pickSingleTable(reqTables, "requests");
  const authTable = pickSingleTable(authTables, "wl-auth");

  if (!reqTable && !authTable) {
    log.info("no source data yet: LB request + wl.auth stdout tables absent", { collector: "usage" });
    return;
  }

  const hostToSlug = Object.fromEntries(apps.map((a) => [a.hostname.toLowerCase(), a.slug]));

  // requests per host + unique users per Cloud Run service, per window, computed inside
  // BigQuery. The 30d user list is fetched only in email mode; in hashed mode nothing
  // but counts ever leaves the query.
  const requestsByWindow = {};
  const usersByWindow = {};
  for (const w of WINDOWS) {
    const withList = w.name === "30d" && USAGE_IDENTITY_MODE === "email";
    requestsByWindow[w.name] = reqTable ? await requestsPerHost(reqTable, w.days) : {};
    usersByWindow[w.name] = authTable ? await uniqueUsersPerService(authTable, w.days, withList) : {};
  }

  const uptime = await uptimeByService(apps.map((a) => a.slug));

  const capturedAt = new Date().toISOString();
  let written = 0;
  for (const app of apps) {
    const host = app.hostname.toLowerCase();
    const service = `${WORKLOAD}-${app.slug}-${ENVIRONMENT}`;
    for (const w of WINDOWS) {
      const requests = (requestsByWindow[w.name][host] || 0);
      const u = usersByWindow[w.name][service] || { users: 0, list: null };
      const avgPerDay = w.days > 0 ? Number((u.users / w.days).toFixed(2)) : null;
      const uptimePct = uptime[app.slug] !== undefined ? uptime[app.slug] : null;
      await upsertUsage({
        slug: app.slug, window: w.name, uniqueUsers: u.users, avgPerDay, requests,
        uptimePct, users: u.list, capturedAt,
      });
      written++;
    }
  }
  log.info("usage snapshots written", { collector: "usage", rows: written, reqTable, authTable });
}

// COUNT(*) of LB requests grouped by requested host. NET.HOST parses the host out of the
// full request URL.
async function requestsPerHost(table, days) {
  try {
    const rows = await query(
      `SELECT LOWER(NET.HOST(httpRequest.requestUrl)) AS host, COUNT(*) AS n
       FROM ${fqTable(table)}
       WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
         AND httpRequest.requestUrl IS NOT NULL
       GROUP BY host`,
      { days },
    );
    return Object.fromEntries(rows.filter((r) => r.host).map((r) => [r.host, Number(r.n)]));
  } catch (err) {
    log.warning("requests query failed", { collector: "usage", days, code: err.code || err.message });
    return {};
  }
}

// COUNT(DISTINCT token) grouped by Cloud Run service, from the apps' wl.auth lines
// (one per user per day; the identity middleware emits them - iap-identity.md). The
// service name is server-derived (resource labels), never app-supplied. withList
// additionally returns the distinct token list (email mode, 30d window only) so the
// portal can show WHO uses an app; in hashed mode tokens never leave the query.
async function uniqueUsersPerService(table, days, withList) {
  // ARRAY_AGG(DISTINCT ...) cannot ORDER BY a different expression, so the cap is
  // applied in BigQuery and the alphabetical sort in JS below.
  const listCol = withList
    ? `, ARRAY_AGG(DISTINCT jsonPayload.user IGNORE NULLS LIMIT 200) AS user_list`
    : "";
  try {
    const rows = await query(
      `SELECT resource.labels.service_name AS service,
              COUNT(DISTINCT jsonPayload.user) AS users${listCol}
       FROM ${fqTable(table)}
       WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
         AND jsonPayload.event = "wl.auth"
       GROUP BY service`,
      { days },
    );
    const out = {};
    for (const r of rows) {
      if (!r.service) continue;
      const list = withList && Array.isArray(r.user_list) ? [...r.user_list].sort() : null;
      out[r.service] = { users: Number(r.users), list };
    }
    return out;
  } catch (err) {
    // Field/table shape can differ across export layouts; degrade to zero rather than fail.
    log.warning("unique-users query failed (degrading to 0)", { collector: "usage", days, code: err.code || err.message });
    return {};
  }
}

// Uptime per app from Cloud Run instance-count metrics: fraction of hourly buckets over
// the last 30d that had at least one instance. Scale-to-zero makes this a DEMAND signal,
// not an SLO. Best-effort - returns {} on any monitoring error.
async function uptimeByService(slugs) {
  const out = {};
  let client;
  try {
    client = new MetricServiceClient();
  } catch (err) {
    log.warning("monitoring client init failed", { collector: "usage", code: err.message });
    return out;
  }
  const now = Date.now();
  const startSec = Math.floor((now - 30 * 24 * 3600 * 1000) / 1000);
  const endSec = Math.floor(now / 1000);
  for (const slug of slugs) {
    const service = `${WORKLOAD}-${slug}-${ENVIRONMENT}`;
    try {
      const [series] = await client.listTimeSeries({
        name: client.projectPath(PROJECT_ID),
        filter: `metric.type="run.googleapis.com/container/instance_count" AND resource.labels.service_name="${service}"`,
        interval: { startTime: { seconds: startSec }, endTime: { seconds: endSec } },
        aggregation: {
          alignmentPeriod: { seconds: 3600 },
          perSeriesAligner: "ALIGN_MAX",
          crossSeriesReducer: "REDUCE_SUM",
          groupByFields: [],
        },
        view: "FULL",
      });
      const buckets = [];
      for (const ts of series) {
        for (const p of ts.points || []) {
          const v = p.value.int64Value !== undefined ? Number(p.value.int64Value) : Number(p.value.doubleValue || 0);
          buckets.push(v);
        }
      }
      if (buckets.length > 0) {
        const up = buckets.filter((v) => v >= 1).length;
        out[slug] = Number(((up / buckets.length) * 100).toFixed(1));
      }
    } catch (err) {
      log.warning("uptime query failed for service", { collector: "usage", service, code: err.code || err.message });
    }
  }
  return out;
}

// Upsert one row per (slug, window). captured_at participates in the unique key, so each
// run appends a fresh point; the portal reads DISTINCT ON (slug, window) newest. users
// is the 30d list in email mode and null everywhere else (hashed mode, other windows).
async function upsertUsage({ slug, window, uniqueUsers, avgPerDay, requests, uptimePct, users, capturedAt }) {
  await pool.query(
    `INSERT INTO usage_snapshots (slug, "window", unique_users, avg_users_per_day, requests, uptime_pct, users, provider, captured_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'gcp',$8)
     ON CONFLICT (slug, "window", captured_at) DO UPDATE SET
       unique_users = EXCLUDED.unique_users, avg_users_per_day = EXCLUDED.avg_users_per_day,
       requests = EXCLUDED.requests, uptime_pct = EXCLUDED.uptime_pct, users = EXCLUDED.users`,
    [slug, window, uniqueUsers, avgPerDay, requests, uptimePct, users ? JSON.stringify(users) : null, capturedAt],
  );
}
