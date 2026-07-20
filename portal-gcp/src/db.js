// Database access + idempotent boot migrations for the portal.
//
// The portal is the ONE platform stack that uses the shared wl_admin database directly
// (docs/portal.md): wl_admin IS the registry it manages. Schema is applied at startup as
// idempotent migrations (CREATE TABLE IF NOT EXISTS ...), the same apply-at-boot rule
// every tenant app follows (shared-db-rls.md), with retry/backoff because a freshly
// created slice can lag the service by a few seconds on first boot.

import pg from "pg";
import { log } from "./logger.js";

const { Pool } = pg;

// sslmode=require on the DSN means "encrypt, do not verify" against the Cloud SQL
// private-IP (self-signed) cert. Set that explicitly here rather than relying on the
// connection-string parser so behaviour is identical across pg versions. sslmode=disable
// (local dev only) turns TLS off entirely.
const DSN = process.env.DATABASE_URL || "";
export const pool = new Pool({
  connectionString: DSN,
  ssl: DSN.includes("sslmode=disable") ? false : { rejectUnauthorized: false },
  max: 5,
  idleTimeoutMillis: 30_000,
});

// THE single owner-email normalization for the whole platform (iap-identity.md). Reuse
// verbatim wherever an email becomes an owner_id, so stored and resolved values match:
// strip control/format/zero-width, NFKC, trim, lowercase (lowercase last).
export function normalizeOwnerEmail(raw) {
  if (typeof raw !== "string") return "";
  // eslint-disable-next-line no-control-regex
  const noControl = Array.from(raw)
    .filter((c) => {
      const code = c.codePointAt(0);
      // Drop C0/C1 control and common zero-width/format chars.
      if (code <= 0x1f || (code >= 0x7f && code <= 0x9f)) return false;
      if (code === 0x200b || code === 0x200c || code === 0x200d || code === 0xfeff) return false;
      return true;
    })
    .join("");
  return noControl.normalize("NFKC").trim().toLowerCase();
}

// --- Migrations -------------------------------------------------------------
// Each entry is guarded and safe to run on every cold start.
const MIGRATIONS = [
  // platform_admins already lives in wl_admin and every tenant app reads it. We do NOT
  // recreate an existing table - CREATE TABLE IF NOT EXISTS is a no-op when it exists,
  // and self-heals a fresh instance so the portal (and tenant apps) can come up. The
  // portal MANAGES this set and must refuse to delete the last row (enforced in code).
  `CREATE TABLE IF NOT EXISTS platform_admins (
     email    text PRIMARY KEY,
     added_by text,
     added_at timestamptz NOT NULL DEFAULT now()
   )`,

  `CREATE TABLE IF NOT EXISTS apps (
     id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     slug           text NOT NULL UNIQUE,
     name           text NOT NULL,
     description    text,
     icon           text,
     docs_url       text,
     repo           text,
     ref            text,
     hostname       text NOT NULL UNIQUE,
     owner_email    text NOT NULL,
     status         text NOT NULL DEFAULT 'registered'
                    CHECK (status IN ('registered', 'deployed', 'archived')),
     archive_reason text,
     created_at     timestamptz NOT NULL DEFAULT now(),
     updated_at     timestamptz NOT NULL DEFAULT now()
   )`,

  // Marks whether slug/hostname were ever bound to a real deploy: slug is immutable once
  // an app has ever been deployed. Tracked so a restore-from-archive still counts as
  // "has been deployed".
  `ALTER TABLE apps ADD COLUMN IF NOT EXISTS ever_deployed boolean NOT NULL DEFAULT false`,

  `CREATE TABLE IF NOT EXISTS app_admins (
     app_id   bigint NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
     email    text NOT NULL,
     added_by text NOT NULL,
     added_at timestamptz NOT NULL DEFAULT now(),
     PRIMARY KEY (app_id, email)
   )`,

  `CREATE TABLE IF NOT EXISTS deployments (
     id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     app_id        bigint NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
     ref           text NOT NULL,
     sha           text,
     dispatched_by text NOT NULL,
     github_run_id bigint,
     status        text NOT NULL DEFAULT 'dispatched'
                   CHECK (status IN ('dispatched', 'running', 'success', 'failure', 'unknown')),
     created_at    timestamptz NOT NULL DEFAULT now(),
     finished_at   timestamptz
   )`,

  `CREATE TABLE IF NOT EXISTS audit_events (
     id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     at           timestamptz NOT NULL DEFAULT now(),
     actor_email  text NOT NULL,
     action       text NOT NULL,
     subject_type text NOT NULL,
     subject_id   text NOT NULL,
     detail       jsonb NOT NULL DEFAULT '{}'::jsonb
   )`,

  // platform_settings: a tiny key-value store for instance chrome (brand name, tagline,
  // icon). Absent keys fall back to code defaults, so no seeding is needed - a fresh
  // instance simply reads as the built-in "Wavelength / control plane".
  `CREATE TABLE IF NOT EXISTS platform_settings (
     key        text PRIMARY KEY,
     value      text NOT NULL,
     updated_by text NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,

  // cost_snapshots (docs/cost-showback.md). Three explicit tiers, never merged.
  `CREATE TABLE IF NOT EXISTS cost_snapshots (
     id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     slug         text NOT NULL,
     period_start date NOT NULL,
     period_end   date NOT NULL,
     attributed   jsonb NOT NULL DEFAULT '{}'::jsonb,
     apportioned  jsonb NOT NULL DEFAULT '{}'::jsonb,
     ai_spend     jsonb NOT NULL DEFAULT '{}'::jsonb,
     currency     text NOT NULL,
     provider     text NOT NULL,
     captured_at  timestamptz NOT NULL DEFAULT now(),
     UNIQUE (slug, period_start, period_end)
   )`,

  // usage_snapshots (docs/usage-telemetry.md). "window" is a reserved word - quoted.
  `CREATE TABLE IF NOT EXISTS usage_snapshots (
     id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     slug              text NOT NULL,
     "window"          text NOT NULL CHECK ("window" IN ('48h', '7d', '30d', 'day')),
     unique_users      integer NOT NULL,
     avg_users_per_day numeric,
     requests          bigint NOT NULL,
     uptime_pct        numeric,
     provider          text NOT NULL,
     captured_at       timestamptz NOT NULL DEFAULT now(),
     UNIQUE (slug, "window", captured_at)
   )`,

  // Platform-updatable apps (docs/portal.md): a non-NULL upstream_repo marks a
  // platform-managed card whose new releases the scheduler watches and whose image the
  // portal can roll via update-platform-app.yml (image-only; the committed tfvars in the
  // platform repo stays the version-of-record). One nullable column both marks the
  // capability and carries the datum the release check needs - no slug inference.
  `ALTER TABLE apps ADD COLUMN IF NOT EXISTS upstream_repo text`,
  // Last tag the PORTAL successfully rolled (NULL until the first portal-driven update).
  `ALTER TABLE apps ADD COLUMN IF NOT EXISTS current_version text`,
  // Latest upstream release seen by the scheduler's weekly check.
  `ALTER TABLE apps ADD COLUMN IF NOT EXISTS available_version text`,
  `ALTER TABLE apps ADD COLUMN IF NOT EXISTS version_checked_at timestamptz`,

  // Deploy schedules: one-off (run_at) and recurring (cron, UTC) rows for both kinds of
  // action. next_fire_at is the single claim key the scheduler tick selects on; the
  // tick advances it (or completes a one-off) BEFORE dispatching, so a crash mid-fire
  // loses at most one fire and can never double-dispatch. auto_update is an inert
  // forward-compatibility flag (recurring platform_update follows the latest release) -
  // rendered, never yet honored.
  `CREATE TABLE IF NOT EXISTS deploy_schedules (
     id              bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
     app_id          bigint NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
     kind            text NOT NULL CHECK (kind IN ('deploy', 'platform_update')),
     cadence         text NOT NULL CHECK (cadence IN ('once', 'recurring')),
     run_at          timestamptz,
     cron            text,
     next_fire_at    timestamptz NOT NULL,
     payload         jsonb NOT NULL DEFAULT '{}'::jsonb,
     auto_update     boolean NOT NULL DEFAULT false,
     created_by      text NOT NULL,
     status          text NOT NULL DEFAULT 'active'
                     CHECK (status IN ('active', 'completed', 'cancelled', 'disabled')),
     disabled_reason text,
     last_fired_at   timestamptz,
     last_result     text,
     created_at      timestamptz NOT NULL DEFAULT now(),
     updated_at      timestamptz NOT NULL DEFAULT now(),
     CHECK ((cadence = 'once' AND run_at IS NOT NULL) OR (cadence = 'recurring' AND cron IS NOT NULL))
   )`,

  // 'deploy' rows carry a git ref in deployments.ref; 'platform_update' rows carry the
  // image tag there (renders naturally in the history table).
  `ALTER TABLE deployments ADD COLUMN IF NOT EXISTS kind text NOT NULL DEFAULT 'deploy'
     CHECK (kind IN ('deploy', 'platform_update'))`,
  `ALTER TABLE deployments ADD COLUMN IF NOT EXISTS schedule_id bigint REFERENCES deploy_schedules(id) ON DELETE SET NULL`,

  // 'restore' joins the kind enum exactly as 'platform_update' did: another kind whose
  // payload rides the existing ref column ('restore' rows store the backup object path
  // there, sha NULL). The inline CHECK above only applies on a fresh install (ADD COLUMN
  // IF NOT EXISTS is a no-op once the column exists), so widening the enum on existing
  // instances means dropping and re-adding Postgres's auto-named constraint - the pair
  // is idempotent and safe to run on every cold start.
  `ALTER TABLE deployments DROP CONSTRAINT IF EXISTS deployments_kind_check`,
  `ALTER TABLE deployments ADD CONSTRAINT deployments_kind_check
     CHECK (kind IN ('deploy', 'platform_update', 'restore'))`,

  `CREATE INDEX IF NOT EXISTS idx_app_admins_email ON app_admins (email)`,
  `CREATE INDEX IF NOT EXISTS idx_deployments_app ON deployments (app_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_schedules_due ON deploy_schedules (next_fire_at) WHERE status = 'active'`,
  `CREATE INDEX IF NOT EXISTS idx_schedules_app ON deploy_schedules (app_id, created_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_cost_slug_period ON cost_snapshots (slug, period_end DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_usage_slug_window ON usage_snapshots (slug, "window", captured_at DESC)`,

  // Data repair (idempotent): a repo-bearing card is 'deployed' only if some run
  // actually succeeded. An earlier portal version flipped status at dispatch time
  // (204 = accepted, not succeeded), stranding failed first deploys as published
  // cards with dead launch links. Healthy rows never match this predicate.
  `UPDATE apps SET status='registered', ever_deployed=false, updated_at=now()
   WHERE repo IS NOT NULL AND status='deployed'
     AND NOT EXISTS (SELECT 1 FROM deployments d WHERE d.app_id = apps.id AND d.status='success')`,
];

export async function migrate() {
  const attempts = 6;
  for (let i = 1; i <= attempts; i++) {
    const client = await pool.connect().catch((err) => {
      log.warning("db connect failed during migrate; will retry", { attempt: i, code: err.code });
      return null;
    });
    if (client) {
      try {
        for (const sql of MIGRATIONS) {
          await client.query(sql);
        }
        client.release();
        log.info("migrations applied", { count: MIGRATIONS.length });
        return;
      } catch (err) {
        client.release();
        log.warning("migration statement failed; will retry", { attempt: i, code: err.code });
      }
    }
    if (i < attempts) await sleep(2000 * i);
  }
  throw new Error("migrations failed after retries");
}

// Seed the platform-managed link-only cards (repo NULL = discoverable, no deploy
// button) and optionally the bootstrap platform admin. All idempotent (ON CONFLICT DO
// NOTHING). Platform apps (the portal itself, Outline) are operator-applied stacks,
// not workflow deploys, so they enter the registry here rather than via registration;
// portal self-deploy needs a context-dir input on deploy-app.yml (upstream candidate).
export async function seed({ platformCards = [], bootstrapAdmin }) {
  const admin = normalizeOwnerEmail(bootstrapAdmin || "");
  if (admin) {
    await pool.query(
      `INSERT INTO platform_admins (email, added_by) VALUES ($1, 'system')
       ON CONFLICT (email) DO NOTHING`,
      [admin],
    );
  }

  const owner = admin || "system";
  for (const card of platformCards) {
    if (!card.hostname) continue;
    const { rows } = await pool.query(
      `INSERT INTO apps (slug, name, description, icon, docs_url, repo, ref, hostname, owner_email, status, ever_deployed)
       VALUES ($1, $2, $3, $4, $5, NULL, NULL, $6, $7, 'deployed', true)
       ON CONFLICT (slug) DO NOTHING
       RETURNING id`,
      [card.slug, card.name, card.description, card.icon, card.docsUrl || null, card.hostname, owner],
    );
    if (rows[0] && admin) {
      await pool.query(
        `INSERT INTO app_admins (app_id, email, added_by) VALUES ($1, $2, 'system')
         ON CONFLICT DO NOTHING`,
        [rows[0].id, admin],
      );
    }
    // Idempotent marker for platform-updatable cards: runs on every boot so EXISTING
    // rows (seeded before the column existed) get it too, and never overwrites an
    // operator-set value.
    if (card.upstreamRepo) {
      await pool.query(
        `UPDATE apps SET upstream_repo = $2 WHERE slug = $1 AND upstream_repo IS NULL`,
        [card.slug, card.upstreamRepo],
      );
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
