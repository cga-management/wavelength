// Usage collector (docs/usage-telemetry.md). Aggregate-only: counts, never who. The
// pipeline reads principal-level identities transiently inside the query for
// COUNT(DISTINCT principal) and discards them with the query - no principal ever lands in
// a snapshot table, a portal screen, or a log line. What is stored and surfaced are
// aggregates.
//
// Join key: host -> slug. The LB request logs know the requested hostname; the registry
// knows each app's hostname (apps.hostname, unique). That join is the entire coupling.
//
// Metrics per app, per window (48h/7d/30d):
//   unique_users      distinct authenticated principals (from IAP data-access audit logs)
//   avg_users_per_day mean daily distinct principals over the window
//   requests          LB request count for the app's hostname
//   uptime_pct        fraction of the window a Cloud Run instance was ready (demand signal)
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

const WINDOWS = [
  { name: "48h", days: 2 },
  { name: "7d", days: 7 },
  { name: "30d", days: 30 },
];

export async function runUsageCollector() {
  const { rows: apps } = await pool.query(
    `SELECT slug, hostname FROM apps WHERE hostname IS NOT NULL AND slug <> '__unattributed__'`,
  );
  if (apps.length === 0) {
    log.info("no apps registered; nothing to aggregate", { collector: "usage" });
    return;
  }

  const [reqTables, iapTables] = await Promise.all([
    findTables("requests%"), // external HTTPS LB request logs
    findTables("cloudaudit_googleapis_com_data_access%"), // IAP data-access audit logs
  ]);
  const reqTable = reqTables[reqTables.length - 1] || null; // newest partition table
  const iapTable = iapTables[iapTables.length - 1] || null;

  if (!reqTable && !iapTable) {
    log.info("no source data yet: LB request + IAP audit tables absent", { collector: "usage" });
    return;
  }

  const hostToSlug = Object.fromEntries(apps.map((a) => [a.hostname.toLowerCase(), a.slug]));

  // requests + unique users per host per window, computed inside BigQuery so identities
  // never leave the query.
  const requestsByWindow = {};
  const usersByWindow = {};
  for (const w of WINDOWS) {
    requestsByWindow[w.name] = reqTable ? await requestsPerHost(reqTable, w.days) : {};
    usersByWindow[w.name] = iapTable ? await uniqueUsersPerHost(iapTable, w.days) : {};
  }

  const uptime = await uptimeByService(apps.map((a) => a.slug));

  const capturedAt = new Date().toISOString();
  let written = 0;
  for (const app of apps) {
    const host = app.hostname.toLowerCase();
    for (const w of WINDOWS) {
      const requests = (requestsByWindow[w.name][host] || 0);
      const uniqueUsers = (usersByWindow[w.name][host] || 0);
      const avgPerDay = w.days > 0 ? Number((uniqueUsers / w.days).toFixed(2)) : null;
      const uptimePct = uptime[app.slug] !== undefined ? uptime[app.slug] : null;
      await upsertUsage({
        slug: app.slug, window: w.name, uniqueUsers, avgPerDay, requests,
        uptimePct, capturedAt,
      });
      written++;
    }
  }
  log.info("usage snapshots written", { collector: "usage", rows: written, reqTable, iapTable });
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

// COUNT(DISTINCT principal) grouped by host, from IAP data-access audit entries. The
// principal is read transiently here for dedup only and never returned or stored.
async function uniqueUsersPerHost(table, days) {
  try {
    const rows = await query(
      `SELECT LOWER(NET.HOST(httpRequest.requestUrl)) AS host,
              COUNT(DISTINCT protopayload_auditlog.authenticationInfo.principalEmail) AS users
       FROM ${fqTable(table)}
       WHERE timestamp >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL @days DAY)
         AND httpRequest.requestUrl IS NOT NULL
       GROUP BY host`,
      { days },
    );
    return Object.fromEntries(rows.filter((r) => r.host).map((r) => [r.host, Number(r.users)]));
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
// run appends a fresh point; the portal reads DISTINCT ON (slug, window) newest.
async function upsertUsage({ slug, window, uniqueUsers, avgPerDay, requests, uptimePct, capturedAt }) {
  await pool.query(
    `INSERT INTO usage_snapshots (slug, "window", unique_users, avg_users_per_day, requests, uptime_pct, provider, captured_at)
     VALUES ($1,$2,$3,$4,$5,$6,'gcp',$7)
     ON CONFLICT (slug, "window", captured_at) DO UPDATE SET
       unique_users = EXCLUDED.unique_users, avg_users_per_day = EXCLUDED.avg_users_per_day,
       requests = EXCLUDED.requests, uptime_pct = EXCLUDED.uptime_pct`,
    [slug, window, uniqueUsers, avgPerDay, requests, uptimePct, capturedAt],
  );
}
