// Small BigQuery helpers shared by the cost and usage collectors. Auth is ADC (the
// collector SA). Both collectors must tolerate a dataset whose export tables do not exist
// yet, so table discovery is explicit.

import { BigQuery } from "@google-cloud/bigquery";
import { log } from "../logger.js";

const PROJECT_ID = process.env.GCP_PROJECT_ID;
const DATASET = process.env.TELEMETRY_DATASET || "wl_telemetry";

export const bq = new BigQuery({ projectId: PROJECT_ID });

// Return the names of tables in the telemetry dataset matching a LIKE pattern, or [] if
// the dataset has no such tables (or does not exist yet).
export async function findTables(likePattern) {
  const sql = `SELECT table_name FROM \`${PROJECT_ID}.${DATASET}.INFORMATION_SCHEMA.TABLES\`
               WHERE table_name LIKE @p ORDER BY table_name`;
  try {
    const [rows] = await bq.query({ query: sql, params: { p: likePattern }, location: process.env.GCP_REGION || "europe-west2" });
    return rows.map((r) => r.table_name);
  } catch (err) {
    // Dataset absent or no permission yet: treat as "no source data".
    log.warning("bigquery table discovery failed", { pattern: likePattern, code: err.code || err.message });
    return [];
  }
}

export async function query(sql, params) {
  const [rows] = await bq.query({ query: sql, params, location: process.env.GCP_REGION || "europe-west2" });
  return rows;
}

export function fqTable(name) {
  return `\`${PROJECT_ID}.${DATASET}.${name}\``;
}

export const datasetName = DATASET;
export const projectId = PROJECT_ID;
