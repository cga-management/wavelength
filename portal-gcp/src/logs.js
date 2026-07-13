// Per-app runtime logs (docs/portal.md, the THIRD sanctioned deviation from the portal
// doctrine). The portal gains exactly ONE read-only cloud capability - Cloud Logging read
// - so an app admin can see their app's recent runtime logs from the card. To keep this
// grant off the SHARED tenant SA (where logging.viewer would cascade onto every app), the
// portal runs as its OWN dedicated service account (id-wl-portal, identity.tf) that holds
// this one extra role. Read-only; per-app scoping is enforced HERE (the filter pins the
// one Cloud Run service) and by the route's authz (canSeeCostUsage). Nothing is stored and
// no log CONTENTS are ever written to the portal's own logs.
//
// Zero new npm dependency: an access token from the GCP metadata server (the same
// credential-free pattern github.js uses for its API calls), then a POST to the Cloud
// Logging REST API.

import { log } from "./logger.js";

const PROJECT_ID = process.env.GCP_PROJECT_ID || "";
const WORKLOAD = process.env.GCP_WORKLOAD || "wl";
const ENVIRONMENT = process.env.GCP_ENVIRONMENT || "platform";
const METADATA_TOKEN_URL =
  "http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/token";
const LOGGING_API = "https://logging.googleapis.com/v2/entries:list";
const PAGE_SIZE = 100;

// Severity floor options offered in the UI. DEFAULT means "no floor" (all entries).
export const SEVERITIES = ["DEFAULT", "INFO", "WARNING", "ERROR"];

// The Cloud Run service name for an app slug is uniform: wl-<slug>-platform. Link-only
// platform cards (portal, outline) still have a real service (wl-portal-platform,
// wl-outline-platform), so we derive uniformly and let empty results speak for a card with
// no matching service.
export function serviceNameFor(slug) {
  return `${WORKLOAD}-${slug}-${ENVIRONMENT}`;
}

// Build the Logging filter for one app's Cloud Run service, optionally floored at a
// severity. resource.labels.service_name pins it to exactly one service - this is the
// per-app scoping boundary in the query itself.
export function buildFilter(slug, severity) {
  const svc = serviceNameFor(slug);
  let filter = `resource.type="cloud_run_revision" AND resource.labels.service_name="${svc}"`;
  if (severity && SEVERITIES.includes(severity) && severity !== "DEFAULT") {
    filter += ` AND severity>=${severity}`;
  }
  return filter;
}

async function accessToken() {
  const res = await fetch(METADATA_TOKEN_URL, { headers: { "Metadata-Flavor": "Google" } });
  if (!res.ok) throw new Error(`metadata token ${res.status}`);
  const data = await res.json();
  return data.access_token;
}

// Reduce one Logging entry to the display fields the panel needs. message: textPayload,
// else jsonPayload.message, else a compact JSON of the structured payload.
function summarize(entry) {
  let message = "";
  if (typeof entry.textPayload === "string") {
    message = entry.textPayload;
  } else if (entry.jsonPayload && typeof entry.jsonPayload.message === "string") {
    message = entry.jsonPayload.message;
  } else if (entry.jsonPayload) {
    message = JSON.stringify(entry.jsonPayload);
  } else if (entry.protoPayload) {
    message = JSON.stringify(entry.protoPayload);
  }
  return {
    timestamp: entry.timestamp || entry.receiveTimestamp || "",
    severity: entry.severity || "DEFAULT",
    message,
  };
}

// Fetch the newest log entries for an app's Cloud Run service. Returns
// { entries: [{ timestamp, severity, message }, ...] } (newest first) on success, or
// { error: "<message>" } on any failure - callers RENDER the error, they never 500 the
// page. Off-platform (no metadata server) surfaces as an honest "unavailable locally".
export async function fetchLogs(slug, { severity } = {}) {
  if (!PROJECT_ID) return { error: "Logs unavailable: no project id configured." };
  let token;
  try {
    token = await accessToken();
  } catch {
    return { error: "Logs are unavailable in local development (no metadata server)." };
  }
  const body = {
    resourceNames: [`projects/${PROJECT_ID}`],
    filter: buildFilter(slug, severity),
    orderBy: "timestamp desc",
    pageSize: PAGE_SIZE,
  };
  let res;
  try {
    res = await fetch(LOGGING_API, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { error: "Logs request failed (could not reach the Cloud Logging API)." };
  }
  if (!res.ok) {
    // Log the status only (no log contents, no token) so the failure stays observable.
    log.warning("logs api error", { slug, status: res.status });
    return { error: `Cloud Logging API returned ${res.status}.` };
  }
  const data = await res.json().catch(() => ({}));
  return { entries: (data.entries || []).map(summarize) };
}
