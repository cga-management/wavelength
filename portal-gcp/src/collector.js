// Collector entrypoint (Layer 2, out-of-process). Runs as a Cloud Run JOB under the
// dedicated, scoped id-wl-collector service account (NEVER the shared app SA) - putting
// billing/BigQuery read on the shared app SA would cascade to every tenant app, exactly
// the grant creep the platform exists to prevent (docs/portal.md, cost-showback.md).
//
// The TABLES are the contract: this job writes normalized rows into cost_snapshots /
// usage_snapshots and the portal renders them, knowing nothing about where they came
// from. Both collectors handle empty/missing sources gracefully (the billing export and
// the log sink accumulate only from enablement) - they log a structured "no source data
// yet" and exit 0.
//
// Usage: node src/collector.js <cost|usage|all>

import { log } from "./logger.js";
import { runCostCollector } from "./collector/cost.js";
import { runUsageCollector } from "./collector/usage.js";
import { pool } from "./db.js";

async function main() {
  const which = (process.argv[2] || process.env.COLLECTOR || "all").toLowerCase();
  log.info("collector start", { which });
  try {
    if (which === "cost" || which === "all") await runCostCollector();
    if (which === "usage" || which === "all") await runUsageCollector();
    log.info("collector done", { which });
    await pool.end();
    process.exit(0);
  } catch (err) {
    log.error("collector failed", { which, message: err.message, stack: err.stack });
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

main();
