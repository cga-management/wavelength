// GitHub deploy dispatch (docs/portal.md, "The deploy dispatch contract"). The portal
// holds ONE narrowly-scoped token (actions:write on the platform repo only) to dispatch
// the platform deploy workflow. Its only cloud credential is the read-only Cloud
// Logging grant on its own SA (logs.js) - nothing here touches the cloud.
//
// The dispatch input names come from the workflow itself
// (.github/workflows/deploy-app.yml): app_repo, ref, app_slug, app_hostname,
// app_owner_email (+ optional image_tag). docs/portal.md sketches shorter names
// (repo/slug/hostname/owner); the workflow's names win.

import { log } from "./logger.js";

const TOKEN = process.env.PORTAL_GITHUB_TOKEN || "";
// The repo that HOSTS deploy-app.yml (this platform repo), not the app repo being deployed.
const PLATFORM_REPO = process.env.PORTAL_PLATFORM_REPO || "";
if (!PLATFORM_REPO) throw new Error("PORTAL_PLATFORM_REPO is required (owner/repo of the platform repo) - set by the portal stack from var.platform_repo");
const WORKFLOW_FILE = process.env.PORTAL_DEPLOY_WORKFLOW || "deploy-app.yml";
const UPDATE_WORKFLOW_FILE = process.env.PORTAL_UPDATE_WORKFLOW || "update-platform-app.yml";
const RESTORE_WORKFLOW_FILE = process.env.PORTAL_RESTORE_WORKFLOW || "restore-app-db.yml";
const API = "https://api.github.com";

// When the token is missing/unseeded the Deploy button renders disabled with a clear
// note; the rest of the portal works fully.
export function tokenConfigured() {
  return TOKEN.length > 0;
}

function headers() {
  return {
    Authorization: `Bearer ${TOKEN}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "wl-portal",
  };
}

// Dispatch the deploy workflow for an app. 204 = accepted (not succeeded): the API returns
// no run id, so the caller records a 'dispatched' row and later locates the run.
export async function dispatchDeploy({ appRepo, ref, slug, hostname, ownerEmail }) {
  if (!tokenConfigured()) throw new Error("dispatch token not configured");
  const url = `${API}/repos/${PLATFORM_REPO}/actions/workflows/${WORKFLOW_FILE}/dispatches`;
  const body = {
    ref: "main", // the ref of the WORKFLOW in the platform repo, not the app's ref
    inputs: {
      app_repo: appRepo,
      ref,
      app_slug: slug,
      app_hostname: hostname,
      app_owner_email: ownerEmail,
    },
  };
  const res = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  if (res.status === 204) {
    log.info("deploy dispatched", { slug, action: "app.deploy.dispatch" });
    return true;
  }
  const detail = await res.text().catch(() => "");
  log.error("deploy dispatch rejected", { slug, status: res.status, detail: detail.slice(0, 200) });
  throw new Error(`dispatch failed: ${res.status}`);
}

// Dispatch the platform-app update workflow (image-only; see
// .github/workflows/update-platform-app.yml). Same 204-accepted semantics as
// dispatchDeploy - the caller records a 'dispatched' row and later locates the run.
export async function dispatchPlatformUpdate({ slug, imageTag, requestedBy }) {
  if (!tokenConfigured()) throw new Error("dispatch token not configured");
  const url = `${API}/repos/${PLATFORM_REPO}/actions/workflows/${UPDATE_WORKFLOW_FILE}/dispatches`;
  const body = {
    ref: "main", // the ref of the WORKFLOW in the platform repo
    inputs: {
      app_slug: slug,
      image_tag: imageTag,
      requested_by: requestedBy || "",
    },
  };
  const res = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  if (res.status === 204) {
    log.info("platform update dispatched", { slug, imageTag, action: "app.update.dispatch" });
    return true;
  }
  const detail = await res.text().catch(() => "");
  log.error("platform update dispatch rejected", { slug, status: res.status, detail: detail.slice(0, 200) });
  throw new Error(`dispatch failed: ${res.status}`);
}

// Dispatch the database restore workflow (.github/workflows/restore-app-db.yml): it
// takes a pre-restore safety dump, then loads the chosen dump over the app's database.
// Same 204-accepted semantics as dispatchDeploy - the caller records a 'dispatched'
// deployments row (kind 'restore', ref = the backup object) and later locates the run.
export async function dispatchRestore({ slug, backupObject, requestedBy }) {
  if (!tokenConfigured()) throw new Error("dispatch token not configured");
  const url = `${API}/repos/${PLATFORM_REPO}/actions/workflows/${RESTORE_WORKFLOW_FILE}/dispatches`;
  const body = {
    ref: "main", // the ref of the WORKFLOW in the platform repo
    inputs: {
      app_slug: slug,
      backup_object: backupObject,
      requested_by: requestedBy || "",
    },
  };
  const res = await fetch(url, { method: "POST", headers: headers(), body: JSON.stringify(body) });
  if (res.status === 204) {
    log.info("restore dispatched", { slug, backupObject, action: "app.restore_backup.dispatch" });
    return true;
  }
  const detail = await res.text().catch(() => "");
  log.error("restore dispatch rejected", { slug, status: res.status, detail: detail.slice(0, 200) });
  throw new Error(`dispatch failed: ${res.status}`);
}

// Map GitHub run status/conclusion to our deployments.status enum.
function mapStatus(run) {
  if (run.status !== "completed") return "running";
  return run.conclusion === "success" ? "success" : "failure";
}

// Locate the workflow run this deployment dispatched (run-name embeds the slug) and return
// { runId, status, sha, finished } if found. Returns null if not yet locatable.
// The run-name formats are load-bearing contracts with the workflows:
//   deploy-app.yml            "deploy <slug> (<repo>@<ref>)"
//   update-platform-app.yml   "update <slug> (<tag>)"
//   restore-app-db.yml        "restore <slug> (<object>)"
// Callers for updates pass workflow/prefix; the defaults keep deploy callers unchanged.
export async function locateRun({ slug, since, workflow = WORKFLOW_FILE, prefix }) {
  if (!tokenConfigured()) return null;
  const url = `${API}/repos/${PLATFORM_REPO}/actions/workflows/${workflow}/runs?event=workflow_dispatch&per_page=30`;
  const res = await fetch(url, { headers: headers() });
  if (!res.ok) {
    log.warning("actions runs list failed", { slug, workflow, status: res.status });
    return null;
  }
  const data = await res.json();
  const runs = data.workflow_runs || [];
  // Match on the slug token and, to avoid catching an older run, only runs created
  // at/after this deployment's dispatch time.
  const needle = prefix || `deploy ${slug} `;
  // GitHub creates the run BEFORE our deployments row is inserted, so an exact
  // created_at >= since comparison can never match the run it dispatched. Allow
  // three minutes of slack.
  const SLACK_MS = 3 * 60 * 1000;
  const match = runs
    .filter((r) => typeof r.name === "string" && r.name.startsWith(needle))
    .filter((r) => !since || new Date(r.created_at).getTime() >= new Date(since).getTime() - SLACK_MS)
    .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
  if (!match) return null;
  return {
    runId: match.id,
    status: mapStatus(match),
    sha: match.head_sha || null,
    finished: match.status === "completed",
  };
}

export const platformRepo = PLATFORM_REPO;
export const updateWorkflowFile = UPDATE_WORKFLOW_FILE;
export const restoreWorkflowFile = RESTORE_WORKFLOW_FILE;
