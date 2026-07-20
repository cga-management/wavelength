// Data access for the registry (Layer 1 neutral core). Every mutation goes through here
// and writes exactly one audit_events row via audit() in the same transaction.

import { pool, normalizeOwnerEmail } from "./db.js";

export async function listApps() {
  const { rows } = await pool.query(`SELECT * FROM apps ORDER BY name ASC`);
  return rows;
}

export async function getApp(id) {
  const { rows } = await pool.query(`SELECT * FROM apps WHERE id = $1`, [id]);
  return rows[0] || null;
}

export async function getAppBySlug(slug) {
  const { rows } = await pool.query(`SELECT * FROM apps WHERE slug = $1`, [slug]);
  return rows[0] || null;
}

export async function appAdmins(appId) {
  const { rows } = await pool.query(
    `SELECT email, added_by, added_at FROM app_admins WHERE app_id = $1 ORDER BY added_at ASC`,
    [appId],
  );
  return rows;
}

export async function platformAdmins() {
  const { rows } = await pool.query(
    `SELECT email, added_by, added_at FROM platform_admins ORDER BY added_at ASC, email ASC`,
  );
  return rows;
}

export async function deploymentsFor(appId, limit = 10) {
  const { rows } = await pool.query(
    `SELECT * FROM deployments WHERE app_id = $1 ORDER BY created_at DESC LIMIT $2`,
    [appId, limit],
  );
  return rows;
}

// The app's FULL deployment history, oldest first, for backup pairing: ordinals
// ("deploy #n") are positions in this list, and the metadata github_run_id join /
// timestamp fallback both need every row, not the display page's last 10.
export async function allDeployments(appId) {
  const { rows } = await pool.query(
    `SELECT * FROM deployments WHERE app_id = $1 ORDER BY created_at ASC, id ASC`,
    [appId],
  );
  return rows;
}

// Distinct previously-successful heads for the pinned-deploy picker, newest first: one
// row per sha (its most recent successful deploy) so the picker never repeats a head.
export async function successfulDeployShas(appId) {
  const { rows } = await pool.query(
    `SELECT sha, ref, created_at FROM (
       SELECT DISTINCT ON (sha) sha, ref, created_at FROM deployments
       WHERE app_id = $1 AND kind = 'deploy' AND status = 'success' AND sha IS NOT NULL
       ORDER BY sha, created_at DESC
     ) heads ORDER BY created_at DESC`,
    [appId],
  );
  return rows;
}

// Server-side validation for a pinned deploy: the sha must appear in THIS app's history
// as a successful deploy. Anything else in the form post is rejected.
export async function shaDeployedSuccessfully(appId, sha) {
  const { rows } = await pool.query(
    `SELECT 1 FROM deployments
     WHERE app_id = $1 AND kind = 'deploy' AND status = 'success' AND sha = $2 LIMIT 1`,
    [appId, sha],
  );
  return rows.length > 0;
}

export async function latestDeployment(appId) {
  const { rows } = await pool.query(
    `SELECT * FROM deployments WHERE app_id = $1 ORDER BY created_at DESC LIMIT 1`,
    [appId],
  );
  return rows[0] || null;
}

// Apps whose LATEST deployment is still non-terminal (dispatched/running) and that can
// have one: repo-bearing apps (deploys) and platform-updatable apps (updates). Used by
// the grid to refresh only those cards on view (bounded set, almost always 0 or 1), so
// a finished run flips the card without opening Details.
export async function appsWithPendingDeployment() {
  const { rows } = await pool.query(
    `SELECT a.* FROM apps a
     JOIN LATERAL (
       SELECT status FROM deployments d WHERE d.app_id = a.id
       ORDER BY d.created_at DESC LIMIT 1
     ) latest ON true
     WHERE (a.repo IS NOT NULL OR a.upstream_repo IS NOT NULL)
       AND latest.status IN ('dispatched', 'running')`,
  );
  return rows;
}

export async function costFor(slug) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (slug) * FROM cost_snapshots WHERE slug = $1
     ORDER BY slug, period_end DESC, captured_at DESC`,
    [slug],
  );
  return rows[0] || null;
}

export async function allLatestCosts() {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (slug) * FROM cost_snapshots
     ORDER BY slug, period_end DESC, captured_at DESC`,
  );
  return rows;
}

export async function usageFor(slug) {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON ("window") "window", unique_users, avg_users_per_day, requests, uptime_pct, captured_at
     FROM usage_snapshots WHERE slug = $1 AND "window" IN ('48h','7d','30d')
     ORDER BY "window", captured_at DESC`,
    [slug],
  );
  const out = {};
  for (const r of rows) out[r.window] = r;
  return out;
}

export async function allLatestUsage() {
  const { rows } = await pool.query(
    `SELECT DISTINCT ON (slug, "window") slug, "window", unique_users, avg_users_per_day, requests, uptime_pct, captured_at
     FROM usage_snapshots WHERE "window" IN ('48h','7d','30d')
     ORDER BY slug, "window", captured_at DESC`,
  );
  const bySlug = {};
  for (const r of rows) {
    bySlug[r.slug] = bySlug[r.slug] || {};
    bySlug[r.slug][r.window] = r;
  }
  return bySlug;
}

// --- Data freshness (Settings > Billing & data) -----------------------------
// Read-only "is my data current?" helpers. Everything from the portal's own Postgres.

export async function latestCostSnapshot() {
  const { rows } = await pool.query(
    `SELECT captured_at, period_start, period_end FROM cost_snapshots
     ORDER BY captured_at DESC LIMIT 1`,
  );
  return rows[0] || null;
}

export async function latestUsageSnapshot() {
  const { rows } = await pool.query(
    `SELECT captured_at FROM usage_snapshots ORDER BY captured_at DESC LIMIT 1`,
  );
  return rows[0] || null;
}

// Count distinct real app slugs with snapshots. Synthetic cost rows (the collector stores
// the unattributed remainder and applied credits under __-prefixed slugs) are excluded so
// the count reflects actual apps.
export async function snapshotCoverage() {
  const { rows } = await pool.query(
    `SELECT
       (SELECT count(DISTINCT slug)::int FROM cost_snapshots  WHERE slug NOT LIKE '\\_\\_%') AS cost_apps,
       (SELECT count(DISTINCT slug)::int FROM usage_snapshots WHERE slug NOT LIKE '\\_\\_%') AS usage_apps`,
  );
  return rows[0] || { cost_apps: 0, usage_apps: 0 };
}

// --- Platform settings (Settings > Branding) --------------------------------
// Tiny key-value store for instance chrome. Absent keys fall back to code defaults.

export async function getSettings() {
  const { rows } = await pool.query(`SELECT key, value FROM platform_settings`);
  const out = {};
  for (const r of rows) out[r.key] = r.value;
  return out;
}

// Upsert one setting and write one audit row. detail carries the KEY only, never the
// value (a branding icon can be an image URL bearing a token - keys only, like logs).
export async function setSetting(actor, key, value, action = "settings.branding") {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO platform_settings (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [key, value, actor],
    );
    await audit(client, { actor, action, subjectType: "platform_settings", subjectId: key, detail: { key } });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// --- Mutations (each writes one audit row) ----------------------------------

export async function audit(client, { actor, action, subjectType, subjectId, detail = {} }) {
  await client.query(
    `INSERT INTO audit_events (actor_email, action, subject_type, subject_id, detail)
     VALUES ($1, $2, $3, $4, $5)`,
    [actor, action, subjectType, String(subjectId), JSON.stringify(detail)],
  );
}

export async function registerApp(actor, a) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO apps (slug, name, description, icon, docs_url, repo, ref, hostname, owner_email, status)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'registered') RETURNING *`,
      [a.slug, a.name, a.description || null, a.icon || null, a.docs_url || null, a.repo || null, a.ref || null, a.hostname, actor],
    );
    const app = rows[0];
    // Registrant becomes owner + first app admin (added_by 'system' for the owner seed).
    await client.query(
      `INSERT INTO app_admins (app_id, email, added_by) VALUES ($1, $2, 'system')`,
      [app.id, actor],
    );
    await audit(client, {
      actor, action: "app.register", subjectType: "app", subjectId: app.id,
      detail: { slug: app.slug, hostname: app.hostname, repo: app.repo },
    });
    await client.query("COMMIT");
    return app;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function editMetadata(actor, app, fields) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE apps SET name=$2, description=$3, icon=$4, docs_url=$5, ref=$6, updated_at=now() WHERE id=$1`,
      [app.id, fields.name, fields.description || null, fields.icon || null, fields.docs_url || null, fields.ref || null],
    );
    await audit(client, {
      actor, action: "app.edit", subjectType: "app", subjectId: app.id,
      detail: { fields: Object.keys(fields) },
    });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Record a dispatched deployment and flip a first deploy to 'deployed'. Returns the
// deployment row so the caller can locate its run later. kind 'deploy' rows carry a git
// ref; kind 'platform_update' rows carry the image tag and kind 'restore' rows the
// backup object path in the same column (sha stays NULL for restores). scheduleId
// marks a fire of a deploy_schedules row (dispatched_by stays the schedule's creator,
// whose authority the scheduler re-verified at fire time). pinned marks a deploy of a
// previously-successful exact sha (the "deploy a previous head" action).
export async function recordDispatch(actor, app, ref, { firstDeploy = false, kind = "deploy", scheduleId = null, pinned = false }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO deployments (app_id, ref, dispatched_by, status, kind, schedule_id)
       VALUES ($1,$2,$3,'dispatched',$4,$5) RETURNING *`,
      [app.id, ref, actor, kind, scheduleId],
    );
    const dep = rows[0];
    // Deliberately NOT flipping apps.status here: the dispatch 204 means accepted,
    // not succeeded (docs/portal.md). The card flips to 'deployed' only when the
    // run's status poll reports success (updateDeploymentStatus).
    const action = kind === "platform_update"
      ? (scheduleId ? "app.update.scheduled" : "app.update.dispatch")
      : kind === "restore"
        ? "app.db.restore"
        : (scheduleId ? "app.deploy.scheduled" : firstDeploy ? "app.deploy.first" : pinned ? "app.deploy.pinned" : "app.deploy.redeploy");
    const detail = kind === "restore"
      ? { slug: app.slug, object: ref }
      : scheduleId ? { slug: app.slug, ref, schedule_id: scheduleId } : { slug: app.slug, ref };
    await audit(client, {
      actor, action,
      subjectType: "deployment", subjectId: dep.id,
      detail,
    });
    await client.query("COMMIT");
    return dep;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function updateDeploymentStatus(depId, { runId, status, sha, finished }) {
  await pool.query(
    `UPDATE deployments SET github_run_id = COALESCE($2, github_run_id), status=$3,
       sha = COALESCE($4, sha), finished_at = CASE WHEN $5 THEN now() ELSE finished_at END
     WHERE id=$1`,
    [depId, runId || null, status, sha || null, !!finished],
  );
  // Success is the only thing that publishes a card (dispatch never does).
  if (status === "success") {
    await pool.query(
      `UPDATE apps SET status='deployed', ever_deployed=true, updated_at=now()
       WHERE id = (SELECT app_id FROM deployments WHERE id=$1 AND kind='deploy') AND status <> 'archived'`,
      [depId],
    );
    // A successful platform update records the tag the portal rolled. The committed
    // tfvars in the platform repo remains the version-of-record; this is display state.
    await pool.query(
      `UPDATE apps SET current_version = d.ref, updated_at=now()
       FROM deployments d WHERE d.id=$1 AND d.kind='platform_update' AND apps.id = d.app_id`,
      [depId],
    );
  }
}

// A deleted dump leaves exactly one trace: this audit row (who, which app, which
// object). The delete itself happens in backups.deleteObject - GCS holds no registry
// row to mutate, so this is an audit-only transaction.
export async function recordBackupDeleted(actor, app, object) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await audit(client, {
      actor, action: "backup.delete", subjectType: "backup", subjectId: object,
      detail: { slug: app.slug, object },
    });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// --- Deploy schedules ---------------------------------------------------------

export async function schedulesFor(appId) {
  const { rows } = await pool.query(
    `SELECT * FROM deploy_schedules WHERE app_id = $1 AND status <> 'cancelled'
     ORDER BY (status = 'active') DESC, next_fire_at ASC, created_at DESC`,
    [appId],
  );
  return rows;
}

export async function getSchedule(id) {
  const { rows } = await pool.query(`SELECT * FROM deploy_schedules WHERE id = $1`, [id]);
  return rows[0] || null;
}

// Create a schedule row. nextFireAt is computed by the caller (run_at for a one-off,
// cron.nextFire for recurring) so this module stays free of cron logic.
export async function createSchedule(actor, app, { kind, cadence, runAt, cron, payload, nextFireAt }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `INSERT INTO deploy_schedules (app_id, kind, cadence, run_at, cron, next_fire_at, payload, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
      [app.id, kind, cadence, runAt || null, cron || null, nextFireAt, JSON.stringify(payload || {}), actor],
    );
    const sched = rows[0];
    await audit(client, {
      actor, action: "schedule.create", subjectType: "schedule", subjectId: sched.id,
      detail: { slug: app.slug, kind, cadence, cron: cron || undefined, run_at: runAt || undefined },
    });
    await client.query("COMMIT");
    return sched;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function cancelSchedule(actor, app, schedule) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE deploy_schedules SET status='cancelled', updated_at=now() WHERE id=$1 AND status='active'`,
      [schedule.id],
    );
    await audit(client, {
      actor, action: "schedule.cancel", subjectType: "schedule", subjectId: schedule.id,
      detail: { slug: app.slug, kind: schedule.kind },
    });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Disable (not delete) a schedule the scheduler refused to fire, with a visible reason.
// A silently skipped schedule would re-skip every fire forever, invisibly; a disabled
// one shows in the UI with why. Actor is 'system' - the scheduler made the call.
export async function disableSchedule(schedule, reason) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `UPDATE deploy_schedules SET status='disabled', disabled_reason=$2, updated_at=now() WHERE id=$1`,
      [schedule.id, reason],
    );
    await audit(client, {
      actor: "system", action: "schedule.disabled", subjectType: "schedule", subjectId: schedule.id,
      detail: { reason, created_by: schedule.created_by, kind: schedule.kind },
    });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function setScheduleResult(scheduleId, result) {
  await pool.query(
    `UPDATE deploy_schedules SET last_result=$2, updated_at=now() WHERE id=$1`,
    [scheduleId, result],
  );
}

export async function setArchive(actor, app, { archived, reason }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (archived) {
      await client.query(
        `UPDATE apps SET status='archived', archive_reason=$2, updated_at=now() WHERE id=$1`,
        [app.id, reason],
      );
    } else {
      // Restore to deployed if it was ever deployed, else back to registered.
      await client.query(
        `UPDATE apps SET status = CASE WHEN ever_deployed THEN 'deployed' ELSE 'registered' END,
           archive_reason=NULL, updated_at=now() WHERE id=$1`,
        [app.id],
      );
    }
    await audit(client, {
      actor, action: archived ? "app.archive" : "app.restore",
      subjectType: "app", subjectId: app.id, detail: archived ? { reason } : {},
    });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function addAppAdmin(actor, app, email) {
  const norm = normalizeOwnerEmail(email);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO app_admins (app_id, email, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [app.id, norm, actor],
    );
    await audit(client, { actor, action: "app.admin.add", subjectType: "app", subjectId: app.id, detail: { target: norm } });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function removeAppAdmin(actor, app, email) {
  const norm = normalizeOwnerEmail(email);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`DELETE FROM app_admins WHERE app_id=$1 AND email=$2`, [app.id, norm]);
    await audit(client, { actor, action: "app.admin.remove", subjectType: "app", subjectId: app.id, detail: { target: norm } });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function transferOwner(actor, app, email) {
  const norm = normalizeOwnerEmail(email);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(`UPDATE apps SET owner_email=$2, updated_at=now() WHERE id=$1`, [app.id, norm]);
    // The new owner is always an app admin.
    await client.query(
      `INSERT INTO app_admins (app_id, email, added_by) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
      [app.id, norm, actor],
    );
    await audit(client, { actor, action: "app.owner.transfer", subjectType: "app", subjectId: app.id, detail: { newOwner: norm } });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

export async function addPlatformAdmin(actor, email) {
  const norm = normalizeOwnerEmail(email);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query(
      `INSERT INTO platform_admins (email, added_by) VALUES ($1,$2) ON CONFLICT DO NOTHING`,
      [norm, actor],
    );
    await audit(client, { actor, action: "platform_admin.add", subjectType: "platform_admin", subjectId: norm, detail: {} });
    await client.query("COMMIT");
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}

// Refuse to delete the last platform_admins row - a registry with zero platform admins is
// unrecoverable from inside the portal. Returns false if the delete was refused.
export async function removePlatformAdmin(actor, email) {
  const norm = normalizeOwnerEmail(email);
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(`SELECT count(*)::int AS n FROM platform_admins`);
    if (rows[0].n <= 1) {
      await client.query("ROLLBACK");
      return false;
    }
    await client.query(`DELETE FROM platform_admins WHERE email=$1`, [norm]);
    await audit(client, { actor, action: "platform_admin.remove", subjectType: "platform_admin", subjectId: norm, detail: {} });
    await client.query("COMMIT");
    return true;
  } catch (e) {
    await client.query("ROLLBACK");
    throw e;
  } finally {
    client.release();
  }
}
