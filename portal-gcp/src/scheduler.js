// Scheduler entrypoint (Layer 2, out-of-process). Runs ONE tick and exits, exactly like
// the collector: a Cloud Run Job under the dedicated, scoped id-wl-scheduler service
// account (NEVER the shared app SA), triggered by Cloud Scheduler every few minutes
// (portal-gcp/scheduler.tf, var.scheduler_tick).
//
// A tick claims due deploy_schedules rows and dispatches them through the same GitHub
// plumbing the interactive routes use. Fires are at-most-once by construction:
//   1. each row is claimed in its own short transaction (FOR UPDATE SKIP LOCKED, so an
//      overlapping tick cannot claim it too);
//   2. the row is advanced FIRST (recurring: next_fire_at moves on; one-off: completed)
//      and committed BEFORE dispatching, so a crash mid-fire loses at most one fire and
//      can never double-dispatch. The job's max_retries is 0 for the same reason.
//   3. authority is re-checked at fire time: the creator's permissions may have changed
//      since the schedule was created. Refusals DISABLE the schedule with a visible
//      reason rather than skipping silently (a skipped schedule re-skips forever,
//      invisibly).
//
// Usage: node src/scheduler.js

import { log } from "./logger.js";
import { pool } from "./db.js";
import * as repo from "./repo.js";
import * as gh from "./github.js";
import { isPlatformAdmin, isAppAdmin } from "./authz.js";
import { nextFire } from "./cron.js";

// Claim (and advance) the next due schedule row, or null when none are due. One row per
// transaction so a bad row never wedges the batch behind it.
async function claimNext() {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const { rows } = await client.query(
      `SELECT * FROM deploy_schedules
       WHERE status = 'active' AND next_fire_at <= now()
       ORDER BY next_fire_at
       FOR UPDATE SKIP LOCKED
       LIMIT 1`,
    );
    const sched = rows[0];
    if (!sched) {
      await client.query("COMMIT");
      return null;
    }
    if (sched.cadence === "recurring") {
      // A cron that no longer parses (should be impossible - validated at creation)
      // must not wedge the tick: disable instead of throwing.
      let nf;
      try {
        nf = nextFire(sched.cron, new Date());
      } catch (err) {
        await client.query(
          `UPDATE deploy_schedules SET status='disabled', disabled_reason=$2, updated_at=now() WHERE id=$1`,
          [sched.id, `cron no longer evaluates: ${err.message}`],
        );
        await client.query("COMMIT");
        return { sched, invalid: true };
      }
      await client.query(
        `UPDATE deploy_schedules SET next_fire_at=$2, last_fired_at=now(), updated_at=now() WHERE id=$1`,
        [sched.id, nf],
      );
    } else {
      await client.query(
        `UPDATE deploy_schedules SET status='completed', last_fired_at=now(), updated_at=now() WHERE id=$1`,
        [sched.id],
      );
    }
    await client.query("COMMIT");
    return { sched };
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

// Fire one claimed schedule: re-check authority, dispatch, record. Every refusal path
// disables the schedule with the reason shown in the UI.
async function fire(sched) {
  const refuse = async (reason) => {
    log.warning("schedule refused at fire time", { scheduleId: sched.id, reason });
    await repo.disableSchedule(sched, reason);
  };

  const app = await repo.getApp(sched.app_id);
  if (!app) return refuse("app no longer exists");
  if (app.status === "archived") return refuse("app is archived");
  if (!gh.tokenConfigured()) return refuse("dispatch token not configured");

  const payload = sched.payload || {};
  let dispatch;
  let ref;
  if (sched.kind === "deploy") {
    if (!app.repo) return refuse("app has no repo (link-only card)");
    // Schedules never perform the first-deploy vetting gate - that stays a deliberate
    // human action by a platform admin.
    if (!app.ever_deployed) return refuse("app has never been deployed (first deploy is a manual platform-admin action)");
    const authorized = (await isPlatformAdmin(sched.created_by)) || (await isAppAdmin(sched.created_by, app.id));
    if (!authorized) return refuse("creator is no longer an admin of this app");
    ref = payload.ref || app.ref || "main";
    dispatch = () => gh.dispatchDeploy({ appRepo: app.repo, ref, slug: app.slug, hostname: app.hostname, ownerEmail: app.owner_email });
  } else if (sched.kind === "platform_update") {
    if (!app.upstream_repo) return refuse("app is not platform-updatable");
    if (!(await isPlatformAdmin(sched.created_by))) return refuse("creator is no longer a platform admin");
    if (typeof gh.dispatchPlatformUpdate !== "function") return refuse("platform update dispatch is not available in this portal version");
    ref = payload.image_tag;
    if (!ref) return refuse("schedule has no image_tag");
    dispatch = () => gh.dispatchPlatformUpdate({ slug: app.slug, imageTag: ref, requestedBy: sched.created_by });
  } else {
    return refuse(`unknown schedule kind: ${sched.kind}`);
  }

  try {
    await dispatch();
    await repo.recordDispatch(sched.created_by, app, ref, { kind: sched.kind, scheduleId: sched.id });
    await repo.setScheduleResult(sched.id, "dispatched");
    log.info("schedule fired", { scheduleId: sched.id, slug: app.slug, kind: sched.kind, ref });
  } catch (err) {
    // A recurring row simply tries again at its next fire; a one-off stays completed
    // with the failure visible in the UI list. Never retried within the tick.
    await repo.setScheduleResult(sched.id, `dispatch_failed: ${err.message}`.slice(0, 200));
    log.error("schedule dispatch failed", { scheduleId: sched.id, slug: app.slug, kind: sched.kind, message: err.message });
  }
}

async function tick() {
  let fired = 0;
  // Bounded loop: a tick never processes more than a sane batch, so a pathological
  // backlog degrades to catching up over several ticks rather than one long run.
  for (let i = 0; i < 25; i++) {
    const claimed = await claimNext();
    if (!claimed) break;
    if (claimed.invalid) continue;
    await fire(claimed.sched);
    fired++;
  }
  return fired;
}

// --- Upstream release detection -----------------------------------------------
// For platform-updatable apps (apps.upstream_repo set), check GitHub's latest release
// weekly and surface it on the card ("Update available"). Detect + approve: nothing is
// dispatched from here - a human triggers or schedules the update. Unauthenticated API
// reads (weekly cadence sits far under the anonymous rate limit; the portal PAT is
// scoped to the platform repo, so it would not help anyway).

async function checkUpstreamReleases() {
  const { rows } = await pool.query(
    `SELECT * FROM apps WHERE upstream_repo IS NOT NULL
     AND (version_checked_at IS NULL OR version_checked_at < now() - interval '7 days')`,
  );
  for (const app of rows) {
    let tag = null;
    try {
      const res = await fetch(`https://api.github.com/repos/${app.upstream_repo}/releases/latest`, {
        headers: { Accept: "application/vnd.github+json", "User-Agent": "wl-portal-scheduler" },
      });
      if (res.ok) {
        const data = await res.json();
        const raw = typeof data.tag_name === "string" ? data.tag_name.replace(/^v/, "") : "";
        // Only strict x.y.z tags are actionable (the update workflow enforces the same
        // shape); anything else is logged and ignored rather than surfaced.
        if (/^\d+\.\d+\.\d+$/.test(raw)) tag = raw;
        else log.warning("upstream release tag ignored (not x.y.z)", { slug: app.slug, tag: raw });
      } else {
        log.warning("release check failed", { slug: app.slug, status: res.status });
      }
    } catch (err) {
      log.warning("release check errored", { slug: app.slug, message: err.message });
    }
    if (tag && tag !== app.available_version) {
      await pool.query(
        `UPDATE apps SET available_version=$2, version_checked_at=now(), updated_at=now() WHERE id=$1`,
        [app.id, tag],
      );
      const client = await pool.connect();
      try {
        await repo.audit(client, {
          actor: "system", action: "platform_update.available",
          subjectType: "app", subjectId: app.id, detail: { slug: app.slug, version: tag },
        });
      } finally {
        client.release();
      }
      log.info("upstream release detected", { slug: app.slug, version: tag });
    } else {
      // Stamp even on failure/no-change so a broken upstream retries weekly, not on
      // every 5-minute tick.
      await pool.query(`UPDATE apps SET version_checked_at=now() WHERE id=$1`, [app.id]);
    }
  }
  return rows.length;
}

async function main() {
  log.info("scheduler tick start", {});
  try {
    const fired = await tick();
    const checked = await checkUpstreamReleases();
    log.info("scheduler tick done", { fired, checked });
    await pool.end();
    process.exit(0);
  } catch (err) {
    log.error("scheduler tick failed", { message: err.message, stack: err.stack });
    await pool.end().catch(() => {});
    process.exit(1);
  }
}

main();
