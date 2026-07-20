// Portal-managed backups (docs/portal.md). Every app deploy exports the app's database
// to the pre-deploy bucket first; this module is the portal's window onto those dumps
// plus the shared instance's own protection (nightly backups + PITR), read live from the
// Cloud SQL Admin API. The capabilities are deliberately narrow, on the portal's OWN
// dedicated service account (never the shared app SA, same rule as logs.js): list/read
// object metadata on the ONE pre-deploy bucket, instances.get on the ONE shared
// instance, and a single mutating call - objects.delete - for the audited, platform-
// admin-only delete action. Restores are NOT performed here: they dispatch a workflow
// (github.js) under the platform's federated CI identity, keeping the portal's own
// blast radius to "can delete a dump", nothing more.
//
// Zero new npm dependency: an access token from the GCP metadata server (the same
// credential-free pattern logs.js uses), then plain fetch against the Storage and
// SQL Admin JSON APIs.
//
// Graceful degradation: DB_PRE_DEPLOY_BUCKET and SQL_INSTANCE_NAME are wired in by the
// portal stack; when either is unset, configured() is false and callers render a
// "not configured on this instance" line instead of calling any API.

import { log } from "./logger.js";

const BUCKET = process.env.DB_PRE_DEPLOY_BUCKET || "";
const SQL_INSTANCE = process.env.SQL_INSTANCE_NAME || "";
const PROJECT_ID = process.env.GCP_PROJECT_ID || "";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const STORAGE_API = "https://storage.googleapis.com/storage/v1";
const SQLADMIN_API = "https://sqladmin.googleapis.com/v1";

// The two prefixes a slug's dumps live under: pre-deploy/<slug>/ (written by
// deploy-app.yml before every deploy) and pre-restore/<slug>/ (safety dumps written by
// restore-app-db.yml before it overwrites the database, metadata reason=pre-restore).
export function prefixesFor(slug) {
  return [`pre-deploy/${slug}/`, `pre-restore/${slug}/`];
}

// Both env vars come from the portal stack; without them the Backups section renders a
// "not configured" line and this module is never called for data.
export function configured() {
  return BUCKET.length > 0 && SQL_INSTANCE.length > 0;
}

export const bucketName = BUCKET;

async function accessToken() {
  const res = await fetch(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) throw new Error(`metadata token ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

// Server-side scoping guard: an action on an object is only ever accepted for objects
// under THIS app's two dump prefixes. Everything else in the bucket (other apps' dumps)
// is out of reach regardless of what the form posts.
export function objectBelongsTo(slug, object) {
  if (typeof object !== "string" || !object || object.includes("..")) return false;
  return prefixesFor(slug).some((p) => object.startsWith(p) && object.length > p.length);
}

// List this app's dumps (both prefixes), newest first. Returns
// { objects: [{ name, size, timeCreated, metadata }, ...] } on success, or
// { error: "<message>" } on any failure - callers RENDER the error, they never 500 the
// page (same contract as logs.fetchLogs).
export async function listDumps(slug) {
  if (!configured()) return { error: "Backups are not configured on this instance." };
  let token;
  try {
    token = await accessToken();
  } catch {
    return { error: "Backups are unavailable in local development (no metadata server)." };
  }
  const objects = [];
  for (const prefix of prefixesFor(slug)) {
    let pageToken;
    do {
      const params = new URLSearchParams({
        prefix,
        fields: "items(name,size,timeCreated,metadata),nextPageToken",
      });
      if (pageToken) params.set("pageToken", pageToken);
      let res;
      try {
        res = await fetch(`${STORAGE_API}/b/${encodeURIComponent(BUCKET)}/o?${params}`, {
          headers: { Authorization: `Bearer ${token}` },
        });
      } catch {
        return { error: "Backup listing failed (could not reach the Cloud Storage API)." };
      }
      if (!res.ok) {
        log.warning("backups list api error", { slug, status: res.status });
        return { error: `Cloud Storage API returned ${res.status}.` };
      }
      const data = await res.json().catch(() => ({}));
      for (const it of data.items || []) {
        objects.push({
          name: it.name,
          size: Number(it.size || 0),
          timeCreated: it.timeCreated || "",
          metadata: it.metadata || {},
        });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
  }
  objects.sort((a, b) => new Date(b.timeCreated) - new Date(a.timeCreated));
  return { objects };
}

// The shared instance's own protection line: nightly automated backups and
// point-in-time recovery, read live from instances.get (settings.backupConfiguration).
// Returns { backupsEnabled, pitrEnabled } or { error } - render, never 500.
export async function instanceProtection() {
  if (!configured()) return { error: "Backups are not configured on this instance." };
  if (!PROJECT_ID) return { error: "Instance protection unavailable: no project id configured." };
  let token;
  try {
    token = await accessToken();
  } catch {
    return { error: "Instance protection is unavailable in local development (no metadata server)." };
  }
  let res;
  try {
    res = await fetch(
      `${SQLADMIN_API}/projects/${PROJECT_ID}/instances/${encodeURIComponent(SQL_INSTANCE)}`,
      { headers: { Authorization: `Bearer ${token}` } },
    );
  } catch {
    return { error: "Instance protection request failed (could not reach the SQL Admin API)." };
  }
  if (!res.ok) {
    log.warning("sql admin api error", { instance: SQL_INSTANCE, status: res.status });
    return { error: `Cloud SQL Admin API returned ${res.status}.` };
  }
  const data = await res.json().catch(() => ({}));
  const cfg = (data.settings || {}).backupConfiguration || {};
  return {
    backupsEnabled: !!cfg.enabled,
    pitrEnabled: !!cfg.pointInTimeRecoveryEnabled,
  };
}

// The one mutating call this module holds: delete a dump object. Callers have already
// enforced platform-admin authz, the typed confirmation and objectBelongsTo, and write
// the backup.delete audit row. 404 also throws - deleting an object that is not there
// should surface, not silently succeed.
export async function deleteObject(object) {
  if (!configured()) throw new Error("backups not configured");
  const token = await accessToken();
  const res = await fetch(
    `${STORAGE_API}/b/${encodeURIComponent(BUCKET)}/o/${encodeURIComponent(object)}`,
    { method: "DELETE", headers: { Authorization: `Bearer ${token}` } },
  );
  if (res.status === 204) return true;
  const detail = await res.text().catch(() => "");
  log.error("backup delete rejected", { status: res.status, detail: detail.slice(0, 200) });
  throw new Error(`delete failed: ${res.status}`);
}
