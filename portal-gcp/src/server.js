// Wavelength admin portal - Layer 1 neutral core (docs/portal.md). Server-rendered
// Express, plain pg, minimal dependencies. Identity comes from the IAP JWT (Layer 3,
// identity.js); authorization is enforced server-side per request (authz.js). Every
// mutation writes one audit_events row (repo.js).

import express from "express";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { migrate, seed } from "./db.js";
import { resolveIdentity, IdentityError } from "./identity.js";
import { permsFor, cardVisible, isPlatformAdmin, isAppAdmin } from "./authz.js";
import * as repo from "./repo.js";
import * as gh from "./github.js";
import * as logs from "./logs.js";
import * as backups from "./backups.js";
import * as v from "./views.js";
import { parseCron, nextFire, minIntervalMs } from "./cron.js";
import { log, traceOf } from "./logger.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = process.env.PORT || 8080;
const APP_DOMAIN = process.env.PORTAL_APP_DOMAIN || "";
if (!APP_DOMAIN) throw new Error("PORTAL_APP_DOMAIN is required (the delegated app subdomain) - set by the portal stack");
const RUN_AGE_OUT_MS = 15 * 60 * 1000; // a run never located ages out to 'unknown'

const app = express();
app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false }));
app.use("/style.css", express.static(path.join(__dirname, "..", "public", "style.css")));
// The one shared progressive-enhancement script: rewrites <time datetime> elements to
// the viewer's zone and converts the schedule picker's local wall-clock to a UTC
// instant before submit (docs/portal.md, "Time and timezones").
app.use("/time.js", express.static(path.join(__dirname, "..", "public", "time.js")));

// Unauthenticated liveness for the Cloud Run startup probe (no identity needed).
app.get("/healthz", (_req, res) => res.type("text").send("ok"));

// --- Identity + CSRF middleware --------------------------------------------
app.use(async (req, res, next) => {
  // CSRF: state-changing requests must originate same-site. Modern browsers send
  // Sec-Fetch-Site; reject cross-site POSTs (IAP's session cookie would otherwise be
  // ridable). Same-origin/same-site/none (address-bar) are allowed.
  if (req.method === "POST") {
    const sfs = req.headers["sec-fetch-site"];
    if (sfs && !["same-origin", "same-site", "none"].includes(sfs)) {
      return res.status(403).send(page403(req, "cross-site request rejected"));
    }
  }
  try {
    req.identity = await resolveIdentity(req);
    // Brand chrome (name/tagline/icon) is instance-wide; fetch it once per request here so
    // every rendered page carries it. One small SELECT alongside the authz queries.
    req.branding = await repo.getSettings();
    next();
  } catch (err) {
    if (err instanceof IdentityError) {
      log.warning("identity rejected", { status: err.status, sub: undefined, traceId: traceOf(req) });
      return res.status(err.status).type("html").send(
        v.layout({ title: "Not authorized", body: v.errorPage(err.status, "Authentication failed. This portal is reachable only through the org SSO."), user: "" }),
      );
    }
    next(err);
  }
});

function page403(req, msg) {
  return v.layout({ title: "Forbidden", body: v.errorPage(403, msg || "You do not have permission for this action."), user: req.identity?.email || "", branding: req.branding });
}

function pageInvalid(req, msg) {
  return v.layout({ title: "Invalid input", body: v.errorPage(400, msg), user: req.identity?.email || "", branding: req.branding });
}

// URL fields rendered into href must be http(s) or empty. esc() stops HTML injection
// but not a javascript: scheme, and the audience guaranteed to click a pending card's
// Docs link is a platform admin - exactly who a hostile registration would target.
function invalidDocsUrl(raw) {
  const s = (raw || "").trim();
  if (!s) return false;
  try {
    return !["http:", "https:"].includes(new URL(s).protocol);
  } catch {
    return true; // not parseable as an absolute URL
  }
}

function render(res, req, { title, body, isPlatformAdmin: pa }) {
  res.type("html").send(v.layout({ title, body, user: req.identity.email, isPlatformAdmin: pa, branding: req.branding }));
}

// --- Home: grid of visible cards -------------------------------------------
app.get("/", async (req, res, next) => {
  try {
    const email = req.identity.email;
    const pa = await isPlatformAdmin(email);
    // Poll-on-grid: refresh the bounded set of repo-bearing apps whose latest deployment is
    // still non-terminal, so a finished deploy flips the card here too (not only when
    // someone opens Details). Sequential; the set is almost always 0 or 1.
    for (const pending of await repo.appsWithPendingDeployment()) {
      await refreshDeploymentStatus(pending);
    }
    const apps = await repo.listApps();
    // Compute per-app visibility. appAdmin check is per app; batch would be nicer but the
    // registry is small. Platform admins see everything.
    const visible = [];
    for (const a of apps) {
      const perms = pa
        ? { platformAdmin: true, appAdmin: true, email }
        : { platformAdmin: false, appAdmin: await isAppAdmin(email, a.id), email };
      if (cardVisible(a, perms)) visible.push(a);
    }
    render(res, req, { title: "Apps", body: v.grid(visible, { email }), isPlatformAdmin: pa });
  } catch (e) {
    next(e);
  }
});

// --- Onboarding wizard ------------------------------------------------------
app.get("/onboard", async (req, res, next) => {
  try {
    const pa = await isPlatformAdmin(req.identity.email);
    // The skill is fetched from the PRIVATE platform repo by design: reading it proves
    // the user holds the same GitHub credentials step 1 (create an org repo) requires,
    // and they get this instance's skill version, not upstream's.
    const body = v.onboardWizard({
      org: gh.platformRepo.split("/")[0],
      appDomain: APP_DOMAIN,
      platformRepo: gh.platformRepo,
      adminContacts: (await repo.platformAdmins()).map((a) => a.email),
    });
    render(res, req, { title: "Onboard an app", body, isPlatformAdmin: pa });
  } catch (e) {
    next(e);
  }
});

// --- Register --------------------------------------------------------------
app.get("/register", async (req, res, next) => {
  try {
    const pa = await isPlatformAdmin(req.identity.email);
    render(res, req, { title: "Register app", body: v.registerForm({}, null, { appDomain: APP_DOMAIN, org: gh.platformRepo.split("/")[0] }), isPlatformAdmin: pa });
  } catch (e) {
    next(e);
  }
});

app.post("/register", async (req, res, next) => {
  try {
    const email = req.identity.email;
    const pa = await isPlatformAdmin(email);
    const b = req.body;
    const slug = (b.slug || "").trim();
    const hostname = (b.hostname || "").trim().toLowerCase();
    const errors = [];
    if (!/^[a-z0-9][a-z0-9-]*$/.test(slug)) errors.push("Slug must be lowercase letters, digits and hyphens.");
    if (!hostname.endsWith("." + APP_DOMAIN)) errors.push(`Hostname must be under ${APP_DOMAIN}.`);
    if (!(b.name || "").trim()) errors.push("Name is required.");
    if (invalidDocsUrl(b.docs_url)) errors.push("Docs URL must be a full http(s) URL.");
    if (errors.length) {
      return render(res, req, { title: "Register app", body: v.registerForm(b, errors.join(" "), { appDomain: APP_DOMAIN, org: gh.platformRepo.split("/")[0] }), isPlatformAdmin: pa });
    }
    try {
      const created = await repo.registerApp(email, {
        slug, name: b.name.trim(), description: b.description, icon: b.icon,
        docs_url: b.docs_url, repo: (b.repo || "").trim() || null, ref: (b.ref || "").trim() || null, hostname,
      });
      log.info("app registered", { slug: created.slug, action: "app.register", traceId: traceOf(req) });
      res.redirect(`/app/${created.id}`);
    } catch (err) {
      const msg = err.code === "23505" ? "That slug or hostname is already registered." : "Could not register the app.";
      render(res, req, { title: "Register app", body: v.registerForm(b, msg, { appDomain: APP_DOMAIN, org: gh.platformRepo.split("/")[0] }), isPlatformAdmin: pa });
    }
  } catch (e) {
    next(e);
  }
});

// --- App detail (poll deployment status on view) ---------------------------
app.get("/app/:id", async (req, res, next) => {
  try {
    const email = req.identity.email;
    const app0 = await repo.getApp(req.params.id);
    if (!app0) return res.status(404).send(page403(req, "No such app."));
    const perms = await permsFor(email, app0);
    if (!cardVisible(app0, perms)) return res.status(403).send(page403(req, "This card is not visible to you."));

    await refreshDeploymentStatus(app0);

    const [admins, deployments, schedules] = await Promise.all([
      repo.appAdmins(app0.id),
      repo.deploymentsFor(app0.id),
      repo.schedulesFor(app0.id),
    ]);
    let cost = null, usage = {}, logsView = null;
    if (perms.canSeeCostUsage()) {
      [cost, usage] = await Promise.all([repo.costFor(app0.slug), repo.usageFor(app0.slug)]);
      // Runtime logs render inline on the detail page (?sev= filters, Refresh reloads it).
      logsView = await logsViewFor(app0, req, req.query.sev, `/app/${app0.id}`);
    }
    const backupsView = perms.canViewBackups() ? await backupsViewFor(app0, perms) : null;
    const deployEnabled = gh.tokenConfigured() && app0.status !== "archived" && !!app0.repo;
    const deployNote = !app0.repo
      ? "link-only card"
      : app0.status === "archived"
        ? "restore the app before deploying"
        : gh.tokenConfigured() ? "" : "dispatch token not configured";
    render(res, req, {
      title: app0.name,
      body: v.cardDetail({ app: app0, perms, admins, deployments, schedules, cost, usage, deployEnabled, deployNote, logsView, backupsView, tokenOk: gh.tokenConfigured() }),
      isPlatformAdmin: perms.platformAdmin,
    });
  } catch (e) {
    next(e);
  }
});

// Poll-on-view: for the latest non-terminal deployment, locate + refresh its run status.
// Platform updates and restores run under different workflows with their own run-name
// contracts.
async function refreshDeploymentStatus(app0) {
  const dep = await repo.latestDeployment(app0.id);
  if (!dep || dep.status === "success" || dep.status === "failure" || dep.status === "unknown") return;
  const located = dep.kind === "platform_update"
    ? await gh.locateRun({ slug: app0.slug, since: dep.created_at, workflow: gh.updateWorkflowFile, prefix: `update ${app0.slug} ` })
    : dep.kind === "restore"
      ? await gh.locateRun({ slug: app0.slug, since: dep.created_at, workflow: gh.restoreWorkflowFile, prefix: `restore ${app0.slug} ` })
      : await gh.locateRun({ slug: app0.slug, since: dep.created_at });
  if (located) {
    await repo.updateDeploymentStatus(dep.id, located);
    return;
  }
  // Never located and older than the age-out window -> 'unknown' (surface, don't pretend).
  const ageMs = Date.now() - new Date(dep.created_at).getTime();
  if (ageMs > RUN_AGE_OUT_MS) {
    await repo.updateDeploymentStatus(dep.id, { status: "unknown", finished: true });
  }
}

// Build the logs view for one app (server-side fetch + render inputs), and emit exactly
// one structured "logs viewed" line per view - the slug and severity filter only, never
// any log contents (logging.md: logs are not per-app isolated). Callers must have already
// checked canSeeCostUsage.
async function logsViewFor(app0, req, sevRaw, selfBase) {
  const sev = typeof sevRaw === "string" ? sevRaw.toUpperCase() : undefined;
  const severity = logs.SEVERITIES.includes(sev) && sev !== "DEFAULT" ? sev : undefined;
  const result = await logs.fetchLogs(app0.slug, { severity });
  const severityFilter = severity || "DEFAULT";
  log.info("logs viewed", { slug: app0.slug, severity_filter: severityFilter, traceId: traceOf(req) });
  return { service: logs.serviceNameFor(app0.slug), result, severity: severityFilter, selfBase };
}

// --- Per-app runtime logs (standalone page) --------------------------------
app.get("/app/:id/logs", async (req, res, next) => {
  try {
    const app0 = await repo.getApp(req.params.id);
    if (!app0) return res.status(404).send(page403(req, "No such app."));
    const perms = await permsFor(req.identity.email, app0);
    if (!cardVisible(app0, perms)) return res.status(403).send(page403(req, "This card is not visible to you."));
    if (!perms.canSeeCostUsage()) return res.status(403).send(page403(req, "Runtime logs are limited to this app's admins."));
    const logsView = await logsViewFor(app0, req, req.query.sev, `/app/${app0.id}/logs`);
    render(res, req, { title: `${app0.name} logs`, body: v.logsPage({ app: app0, ...logsView }), isPlatformAdmin: perms.platformAdmin });
  } catch (e) {
    next(e);
  }
});

// --- Backups (portal-managed backups) ----------------------------------------
// Every deploy exports the app's database to the pre-deploy bucket first; restores
// write a safety dump under pre-restore/. The section is read-only reassurance for the
// app's owner and admins; every ACTION (restore, delete, pinned deploy) is
// platform-admin only. When the stack has not wired the env vars in, the section
// renders a "not configured" line and no cloud API is called.

// Build the Backups view model for one app: instance protection (live from the Cloud
// SQL Admin API), the app's dumps paired with their deployments, and (for platform
// admins) the pinned-deploy picker rows. Callers must have checked canViewBackups.
async function backupsViewFor(app0, perms) {
  if (!backups.configured()) return { configured: false };
  const [protection, listed, history] = await Promise.all([
    backups.instanceProtection(),
    backups.listDumps(app0.slug),
    repo.allDeployments(app0.id),
  ]);
  const pinned = perms.canDeployPinned() ? await repo.successfulDeployShas(app0.id) : [];
  return {
    configured: true,
    protection,
    listError: listed.error || null,
    dumps: listed.error ? [] : pairDumps(listed.objects, history),
    pinned,
  };
}

// Display form of a deployment's head: sha preferred, else the ref; shortened to 7.
function shortHead(d) {
  return String(d.sha || d.ref || "?").slice(0, 7);
}

// Pair each dump with its deployments. The join: object metadata github_run_id ->
// deployments.github_run_id gives the run the dump was "taken before" (deploy #n); the
// app's latest EARLIER successful code deploy gives "matching code" (deploy #n-1).
// Older dumps predate the metadata stamp, so fall back to timestamps: the dump is
// written during its run, shortly AFTER that run's deployments row was created, making
// the latest row at or before the object's creation time the run it belongs to.
// Ordinals ("deploy #n") are positions among the app's kind='deploy' rows, oldest first.
function pairDumps(objects, history) {
  const deploys = history.filter((d) => d.kind === "deploy");
  const restores = history.filter((d) => d.kind === "restore");
  const ordinal = new Map(deploys.map((d, i) => [d.id, i + 1]));
  const byRunId = new Map();
  for (const d of history) if (d.github_run_id) byRunId.set(String(d.github_run_id), d);
  const at = (x) => new Date(x).getTime();

  return objects.map((o) => {
    const meta = o.metadata || {};
    const preRestore = o.name.startsWith("pre-restore/") || meta.reason === "pre-restore";
    let taken = meta.github_run_id ? byRunId.get(String(meta.github_run_id)) || null : null;
    let estimated = false;
    if (!taken && o.timeCreated) {
      const pool0 = preRestore ? restores : deploys;
      taken = [...pool0].reverse().find((d) => at(d.created_at) <= at(o.timeCreated)) || null;
      estimated = !!taken;
    }
    // Matching code: the latest successful code deploy strictly before the run the dump
    // preceded (or before the dump itself when no run was identified).
    const before = taken ? at(taken.created_at) : (o.timeCreated ? at(o.timeCreated) : 0);
    const matching = [...deploys].reverse()
      .find((d) => d.status === "success" && at(d.created_at) < before) || null;
    return {
      object: o.name,
      base: o.name.slice(o.name.lastIndexOf("/") + 1),
      size: o.size,
      timeCreated: o.timeCreated,
      preRestore,
      estimated,
      taken: taken ? { kind: taken.kind, n: ordinal.get(taken.id) || null, head: shortHead(taken) } : null,
      matching: matching ? { n: ordinal.get(matching.id) || null, head: shortHead(matching) } : null,
    };
  });
}

// Shared validation for the two per-dump actions: platform-scoped object shape and the
// typed confirmation (the admin types the app's slug - deliberate friction on the two
// actions that can lose data).
function invalidBackupAction(req, res, app0, object) {
  if (!backups.objectBelongsTo(app0.slug, object)) {
    res.status(400).send(pageInvalid(req, "That object is not one of this app's dumps."));
    return true;
  }
  if ((req.body.confirm || "").trim() !== app0.slug) {
    res.status(400).send(pageInvalid(req, `Type the app slug (${app0.slug}) in the confirm field to proceed.`));
    return true;
  }
  return false;
}

// Restore a dump over the app's database (platform-admin only): dispatch
// restore-app-db.yml, record a kind='restore' deployments row and reuse the deploy
// status plumbing end to end, so the card shows restore progress like a deploy.
app.post("/app/:id/backups/restore", async (req, res, next) => {
  try {
    const email = req.identity.email;
    const app0 = await repo.getApp(req.params.id);
    if (!app0) return res.status(404).send(page403(req, "No such app."));
    const perms = await permsFor(email, app0);
    if (!perms.canRestoreBackup()) return res.status(403).send(page403(req, "Restoring a backup is platform-admin only."));
    if (!backups.configured()) return res.status(503).send(page403(req, "Backups are not configured on this instance."));
    if (app0.status === "archived") return res.status(409).send(page403(req, "Restore the app before restoring its database."));
    if (!gh.tokenConfigured()) return res.status(503).send(page403(req, "Dispatch token not configured."));
    const object = (req.body.object || "").trim();
    if (invalidBackupAction(req, res, app0, object)) return;
    // Mirror the deploy button's in-progress guard: one run at a time per app.
    const latest = await repo.latestDeployment(app0.id);
    if (latest && (latest.status === "dispatched" || latest.status === "running")) {
      return res.status(409).send(page403(req, "A deployment or update is already in progress; wait for it to finish."));
    }
    await gh.dispatchRestore({ slug: app0.slug, backupObject: object, requestedBy: email });
    await repo.recordDispatch(email, app0, object, { kind: "restore" });
    log.info("restore recorded", { slug: app0.slug, object, action: "app.restore_backup", traceId: traceOf(req) });
    res.redirect(`/app/${app0.id}`);
  } catch (e) {
    next(e);
  }
});

// Delete a dump (platform-admin only): typed confirmation, direct GCS delete, one
// backup.delete audit row. No workflow involved.
app.post("/app/:id/backups/delete", async (req, res, next) => {
  try {
    const email = req.identity.email;
    const app0 = await repo.getApp(req.params.id);
    if (!app0) return res.status(404).send(page403(req, "No such app."));
    const perms = await permsFor(email, app0);
    if (!perms.canDeleteBackup()) return res.status(403).send(page403(req, "Deleting a backup is platform-admin only."));
    if (!backups.configured()) return res.status(503).send(page403(req, "Backups are not configured on this instance."));
    const object = (req.body.object || "").trim();
    if (invalidBackupAction(req, res, app0, object)) return;
    await backups.deleteObject(object);
    await repo.recordBackupDeleted(email, app0, object);
    log.info("backup deleted", { slug: app0.slug, object, action: "backup.delete", traceId: traceOf(req) });
    res.redirect(`/app/${app0.id}`);
  } catch (e) {
    next(e);
  }
});

// Deploy a previous head (platform-admin only): redeploy any sha this app has already
// deployed successfully, via the ordinary deploy workflow with ref = the exact 40-char
// sha (deploy-app.yml accepts exact shas). The sha must appear in this app's history
// with status success - the picker offers only those, and the server re-checks.
app.post("/app/:id/backups/deploy-pinned", async (req, res, next) => {
  try {
    const email = req.identity.email;
    const app0 = await repo.getApp(req.params.id);
    if (!app0) return res.status(404).send(page403(req, "No such app."));
    const perms = await permsFor(email, app0);
    if (!perms.canDeployPinned()) return res.status(403).send(page403(req, "Deploying a previous head is platform-admin only."));
    if (app0.status === "archived") return res.status(409).send(page403(req, "Restore the app before deploying."));
    if (!app0.repo) return res.status(409).send(page403(req, "Link-only card: nothing to deploy."));
    if (!gh.tokenConfigured()) return res.status(503).send(page403(req, "Dispatch token not configured."));
    const sha = (req.body.sha || "").trim().toLowerCase();
    if (!/^[0-9a-f]{40}$/.test(sha)) return res.status(400).send(pageInvalid(req, "Pick a previously deployed head (a full 40-character sha)."));
    if (!(await repo.shaDeployedSuccessfully(app0.id, sha))) {
      return res.status(400).send(pageInvalid(req, "That sha has never been successfully deployed for this app."));
    }
    const latest = await repo.latestDeployment(app0.id);
    if (latest && (latest.status === "dispatched" || latest.status === "running")) {
      return res.status(409).send(page403(req, "A deployment or update is already in progress; wait for it to finish."));
    }
    await gh.dispatchDeploy({ appRepo: app0.repo, ref: sha, slug: app0.slug, hostname: app0.hostname, ownerEmail: app0.owner_email });
    await repo.recordDispatch(email, app0, sha, { pinned: true });
    log.info("pinned deploy recorded", { slug: app0.slug, sha: sha.slice(0, 7), action: "app.deploy.pinned", traceId: traceOf(req) });
    res.redirect(`/app/${app0.id}`);
  } catch (e) {
    next(e);
  }
});

// --- Deploy dispatch -------------------------------------------------------
app.post("/app/:id/deploy", async (req, res, next) => {
  try {
    const email = req.identity.email;
    const app0 = await repo.getApp(req.params.id);
    if (!app0) return res.status(404).send(page403(req, "No such app."));
    const perms = await permsFor(email, app0);
    if (app0.status === "archived") return res.status(409).send(page403(req, "Restore the app before deploying."));
    if (!app0.repo) return res.status(409).send(page403(req, "Link-only card: nothing to deploy."));
    const firstDeploy = !app0.ever_deployed;
    const allowed = firstDeploy ? perms.canFirstDeploy() : perms.canRedeploy();
    if (!allowed) return res.status(403).send(page403(req, firstDeploy ? "First deploy is platform-admin only." : "Redeploy is limited to app admins."));
    if (!gh.tokenConfigured()) return res.status(503).send(page403(req, "Dispatch token not configured."));

    const ref = app0.ref || "main";
    await gh.dispatchDeploy({ appRepo: app0.repo, ref, slug: app0.slug, hostname: app0.hostname, ownerEmail: app0.owner_email });
    await repo.recordDispatch(email, app0, ref, { firstDeploy });
    log.info("deploy recorded", { slug: app0.slug, firstDeploy, action: "app.deploy", traceId: traceOf(req) });
    res.redirect(`/app/${app0.id}`);
  } catch (e) {
    next(e);
  }
});

// --- Platform-app update dispatch --------------------------------------------
// Image-only update of a platform-managed app (apps.upstream_repo set), through
// update-platform-app.yml. Strictly platform-admin: these are shared platform services,
// not tenant apps with their own admins.
app.post("/app/:id/update", async (req, res, next) => {
  try {
    const email = req.identity.email;
    const app0 = await repo.getApp(req.params.id);
    if (!app0) return res.status(404).send(page403(req, "No such app."));
    const perms = await permsFor(email, app0);
    if (!perms.platformAdmin) return res.status(403).send(page403(req, "Platform-app updates are platform-admin only."));
    if (!app0.upstream_repo) return res.status(409).send(page403(req, "This app is not platform-updatable."));
    if (app0.status === "archived") return res.status(409).send(page403(req, "Restore the app before updating."));
    if (!gh.tokenConfigured()) return res.status(503).send(page403(req, "Dispatch token not configured."));
    const tag = (req.body.image_tag || "").trim().replace(/^v/, "");
    if (!/^\d+\.\d+\.\d+$/.test(tag)) return res.status(400).send(pageInvalid(req, "Image tag must look like 1.2.3."));
    // Mirror the deploy button's in-progress guard: one run at a time per app.
    const latest = await repo.latestDeployment(app0.id);
    if (latest && (latest.status === "dispatched" || latest.status === "running")) {
      return res.status(409).send(page403(req, "A deployment or update is already in progress; wait for it to finish."));
    }
    await gh.dispatchPlatformUpdate({ slug: app0.slug, imageTag: tag, requestedBy: email });
    await repo.recordDispatch(email, app0, tag, { kind: "platform_update" });
    log.info("platform update recorded", { slug: app0.slug, tag, action: "app.update", traceId: traceOf(req) });
    res.redirect(`/app/${app0.id}`);
  } catch (e) {
    next(e);
  }
});

// --- Deploy schedules --------------------------------------------------------
// One-off (run_at) and recurring (cron, UTC) schedules, fired by the out-of-process
// scheduler job (src/scheduler.js), which re-verifies the creator's authority at fire
// time. Scheduling never performs the first-deploy vetting gate.

const MIN_CRON_INTERVAL_MS = 15 * 60 * 1000;

app.post("/app/:id/schedule", async (req, res, next) => {
  try {
    const email = req.identity.email;
    const app0 = await repo.getApp(req.params.id);
    if (!app0) return res.status(404).send(page403(req, "No such app."));
    const perms = await permsFor(email, app0);
    if (app0.status === "archived") return res.status(409).send(page403(req, "Restore the app before scheduling."));
    if (!gh.tokenConfigured()) return res.status(503).send(page403(req, "Dispatch token not configured."));

    const action = req.body.action;
    let kind;
    let payload = {};
    if (action === "deploy") {
      if (!app0.repo) return res.status(409).send(page403(req, "Link-only card: nothing to deploy."));
      if (!app0.ever_deployed) return res.status(409).send(page403(req, "First deploy is a manual platform-admin action; schedules only redeploy."));
      if (!perms.canRedeploy()) return res.status(403).send(page403(req, "Scheduling a deploy is limited to this app's admins."));
      kind = "deploy";
    } else if (action === "update") {
      if (!app0.upstream_repo) return res.status(409).send(page403(req, "This app is not platform-updatable."));
      if (!perms.platformAdmin) return res.status(403).send(page403(req, "Scheduling a platform update is platform-admin only."));
      const tag = (req.body.image_tag || "").trim().replace(/^v/, "");
      if (!/^\d+\.\d+\.\d+$/.test(tag)) return res.status(400).send(pageInvalid(req, "Image tag must look like 1.2.3."));
      kind = "platform_update";
      payload = { image_tag: tag };
    } else {
      return res.status(400).send(pageInvalid(req, "Unknown schedule action."));
    }

    const cadence = req.body.cadence === "recurring" ? "recurring" : "once";
    let runAt = null;
    let cron = null;
    let nextFireAt;
    if (cadence === "once") {
      // The picker posts local wall-clock; client JS (public/time.js) converts it to a
      // UTC instant before submit. Accept ONLY a Z-suffixed ISO-8601 instant here: a
      // zoneless value is ambiguous (the picked-10:00-fired-11:00 incident class this
      // convention exists to kill), so a JS-off submit fails loudly instead of firing
      // an hour off (docs/portal.md, "Time and timezones").
      const raw = (req.body.run_at || "").trim();
      if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,3})?)?Z$/.test(raw)) {
        return res.status(400).send(pageInvalid(req, "A one-off needs its run time as a UTC instant (ISO-8601 ending in Z). The form converts your local pick automatically; enable JavaScript if this keeps failing."));
      }
      const parsed = new Date(raw);
      if (isNaN(parsed.getTime())) return res.status(400).send(pageInvalid(req, "That run time is not a valid instant."));
      if (parsed.getTime() <= Date.now()) return res.status(400).send(pageInvalid(req, "The run time must be in the future."));
      runAt = parsed;
      nextFireAt = parsed;
    } else {
      cron = (req.body.cron || "").trim();
      try {
        parseCron(cron);
        nextFireAt = nextFire(cron);
      } catch (err) {
        return res.status(400).send(pageInvalid(req, `Invalid cron: ${err.message}`));
      }
      // Guardrail: a schedule must never dispatch on every scheduler tick.
      if (minIntervalMs(cron) < MIN_CRON_INTERVAL_MS) {
        return res.status(400).send(pageInvalid(req, "That cron fires more often than every 15 minutes; use a wider interval."));
      }
    }

    const sched = await repo.createSchedule(email, app0, { kind, cadence, runAt, cron, payload, nextFireAt });
    log.info("schedule created", { slug: app0.slug, scheduleId: sched.id, kind, cadence, action: "schedule.create", traceId: traceOf(req) });
    res.redirect(`/app/${app0.id}`);
  } catch (e) {
    next(e);
  }
});

app.post("/app/:id/schedule/:sid/cancel", async (req, res, next) => {
  try {
    const email = req.identity.email;
    const app0 = await repo.getApp(req.params.id);
    if (!app0) return res.status(404).send(page403(req, "No such app."));
    const perms = await permsFor(email, app0);
    const sched = await repo.getSchedule(req.params.sid);
    if (!sched || String(sched.app_id) !== String(app0.id)) return res.status(404).send(page403(req, "No such schedule."));
    if (!(perms.platformAdmin || sched.created_by === email)) {
      return res.status(403).send(page403(req, "Only the schedule's creator or a platform admin can cancel it."));
    }
    await repo.cancelSchedule(email, app0, sched);
    log.info("schedule cancelled", { slug: app0.slug, scheduleId: sched.id, action: "schedule.cancel", traceId: traceOf(req) });
    res.redirect(`/app/${app0.id}`);
  } catch (e) {
    next(e);
  }
});

// --- Edit metadata ---------------------------------------------------------
app.get("/app/:id/edit", async (req, res, next) => {
  try {
    const app0 = await repo.getApp(req.params.id);
    if (!app0) return res.status(404).send(page403(req, "No such app."));
    const perms = await permsFor(req.identity.email, app0);
    if (!perms.canEditMetadata()) return res.status(403).send(page403(req, "Only app admins can edit metadata."));
    render(res, req, { title: `Edit ${app0.name}`, body: v.editForm(app0), isPlatformAdmin: perms.platformAdmin });
  } catch (e) {
    next(e);
  }
});

app.post("/app/:id/edit", async (req, res, next) => {
  try {
    const app0 = await repo.getApp(req.params.id);
    if (!app0) return res.status(404).send(page403(req, "No such app."));
    const perms = await permsFor(req.identity.email, app0);
    if (!perms.canEditMetadata()) return res.status(403).send(page403(req, "Only app admins can edit metadata."));
    const b = req.body;
    if (invalidDocsUrl(b.docs_url)) return res.status(400).send(pageInvalid(req, "Docs URL must be a full http(s) URL."));
    // slug + hostname are intentionally not editable here (slug immutable once deployed).
    await repo.editMetadata(req.identity.email, app0, {
      name: (b.name || app0.name).trim(), description: b.description, icon: b.icon, docs_url: b.docs_url, ref: b.ref,
    });
    res.redirect(`/app/${app0.id}`);
  } catch (e) {
    next(e);
  }
});

// --- Archive / restore -----------------------------------------------------
app.post("/app/:id/archive", async (req, res, next) => {
  try {
    const app0 = await repo.getApp(req.params.id);
    if (!app0) return res.status(404).send(page403(req, "No such app."));
    const perms = await permsFor(req.identity.email, app0);
    if (!perms.canArchiveRestore()) return res.status(403).send(page403(req, "Archive is platform-admin only."));
    const reason = (req.body.reason || "").trim();
    if (!reason) return res.status(400).send(page403(req, "An archive reason is required."));
    await repo.setArchive(req.identity.email, app0, { archived: true, reason });
    log.info("app archived", { slug: app0.slug, action: "app.archive", traceId: traceOf(req) });
    res.redirect(`/app/${app0.id}`);
  } catch (e) {
    next(e);
  }
});

app.post("/app/:id/restore", async (req, res, next) => {
  try {
    const app0 = await repo.getApp(req.params.id);
    if (!app0) return res.status(404).send(page403(req, "No such app."));
    const perms = await permsFor(req.identity.email, app0);
    if (!perms.canArchiveRestore()) return res.status(403).send(page403(req, "Restore is platform-admin only."));
    await repo.setArchive(req.identity.email, app0, { archived: false });
    res.redirect(`/app/${app0.id}`);
  } catch (e) {
    next(e);
  }
});

// --- App admin management + owner transfer (platform admin only) -----------
app.post("/app/:id/admins/add", async (req, res, next) => {
  try {
    const app0 = await repo.getApp(req.params.id);
    if (!app0) return res.status(404).send(page403(req, "No such app."));
    const perms = await permsFor(req.identity.email, app0);
    if (!perms.canManageAppAdmins()) return res.status(403).send(page403(req, "Managing app admins is platform-admin only."));
    if (req.body.email) await repo.addAppAdmin(req.identity.email, app0, req.body.email);
    res.redirect(`/app/${app0.id}`);
  } catch (e) {
    next(e);
  }
});

app.post("/app/:id/admins/remove", async (req, res, next) => {
  try {
    const app0 = await repo.getApp(req.params.id);
    if (!app0) return res.status(404).send(page403(req, "No such app."));
    const perms = await permsFor(req.identity.email, app0);
    if (!perms.canManageAppAdmins()) return res.status(403).send(page403(req, "Managing app admins is platform-admin only."));
    if (req.body.email) await repo.removeAppAdmin(req.identity.email, app0, req.body.email);
    res.redirect(`/app/${app0.id}`);
  } catch (e) {
    next(e);
  }
});

app.post("/app/:id/owner", async (req, res, next) => {
  try {
    const app0 = await repo.getApp(req.params.id);
    if (!app0) return res.status(404).send(page403(req, "No such app."));
    const perms = await permsFor(req.identity.email, app0);
    if (!perms.canManageAppAdmins()) return res.status(403).send(page403(req, "Ownership transfer is platform-admin only."));
    if (req.body.email) await repo.transferOwner(req.identity.email, app0, req.body.email);
    res.redirect(`/app/${app0.id}`);
  } catch (e) {
    next(e);
  }
});

// --- Portfolio (platform admins only) --------------------------------------
app.get("/portfolio", async (req, res, next) => {
  try {
    const pa = await isPlatformAdmin(req.identity.email);
    if (!pa) return res.status(403).send(page403(req, "Portfolio is platform-admin only."));
    const [apps, costs, usage] = await Promise.all([repo.listApps(), repo.allLatestCosts(), repo.allLatestUsage()]);
    // Split off the explicit unattributed remainder line (collector stores it as a
    // synthetic slug), so the rollup reconciles to the bill.
    const remainderRow = costs.find((c) => c.slug === "__unattributed__");
    const creditsRow = costs.find((c) => c.slug === "__credits__");
    const SYNTHETIC = new Set(["__unattributed__", "__credits__"]);
    const appCosts = costs.filter((c) => !SYNTHETIC.has(c.slug));
    const remainder = remainderRow ? Number((remainderRow.attributed || {}).remainder || 0) : 0;
    const credits = creditsRow ? Number((creditsRow.attributed || {}).credits_applied || 0) : 0;
    const currency = (costs[0] && costs[0].currency) || "GBP";
    render(res, req, {
      title: "Portfolio",
      body: v.portfolio({ apps: apps.filter((a) => !SYNTHETIC.has(a.slug)), costs: appCosts, usage, remainder, credits, currency }),
      isPlatformAdmin: true,
    });
  } catch (e) {
    next(e);
  }
});

// --- Settings ---------------------------------------------------------------
// Two-column area. Appearance is open to everyone; the platform-admin sections keep
// their server-side guards (the sub-nav hiding them is convenience, not enforcement).

// Appearance (default section) - all authenticated users.
app.get("/settings", async (req, res, next) => {
  try {
    const pa = await isPlatformAdmin(req.identity.email);
    const body = v.settingsPage({ active: "appearance", content: v.appearanceSection(), isPlatformAdmin: pa });
    render(res, req, { title: "Settings", body, isPlatformAdmin: pa });
  } catch (e) {
    next(e);
  }
});

// Branding (platform-admin only): rename the instance and set its icon. The form shows the
// currently effective brand (stored value or code default).
app.get("/settings/branding", async (req, res, next) => {
  try {
    const pa = await isPlatformAdmin(req.identity.email);
    if (!pa) return res.status(403).send(page403(req, "Platform-admin only."));
    const brand = v.brandFrom(req.branding);
    const content = v.brandingSection(brand, req.query.saved === "1");
    render(res, req, { title: "Branding", body: v.settingsPage({ active: "branding", content, isPlatformAdmin: true }), isPlatformAdmin: true });
  } catch (e) {
    next(e);
  }
});

app.post("/settings/branding", async (req, res, next) => {
  try {
    const email = req.identity.email;
    const pa = await isPlatformAdmin(email);
    if (!pa) return res.status(403).send(page403(req, "Platform-admin only."));
    const current = v.brandFrom(req.branding);
    // A blank name is not a valid brand, so keep the current one if the field came empty.
    const submitted = {
      brand_name: (req.body.name || "").trim() || current.name,
      brand_tagline: (req.body.tagline || "").trim(),
      brand_icon: (req.body.icon || "").trim(),
    };
    const currentByKey = { brand_name: current.name, brand_tagline: current.tagline, brand_icon: current.icon };
    const changed = [];
    for (const key of Object.keys(submitted)) {
      if (submitted[key] !== currentByKey[key]) {
        await repo.setSetting(email, key, submitted[key]);
        changed.push(key);
      }
    }
    // Keys only, never values (a branding icon can be an image URL bearing a token).
    if (changed.length) log.info("branding updated", { action: "settings.branding", keys: changed, traceId: traceOf(req) });
    res.redirect("/settings/branding?saved=1");
  } catch (e) {
    next(e);
  }
});

// Platform admins moved under Settings. Same view + POST routes as before.
app.get("/settings/platform-admins", async (req, res, next) => {
  try {
    const pa = await isPlatformAdmin(req.identity.email);
    if (!pa) return res.status(403).send(page403(req, "Platform-admin only."));
    const admins = await repo.platformAdmins();
    const content = v.platformAdminsView({ admins, canManage: true });
    render(res, req, { title: "Platform admins", body: v.settingsPage({ active: "platform-admins", content, isPlatformAdmin: true }), isPlatformAdmin: true });
  } catch (e) {
    next(e);
  }
});

// Billing & data: read-only freshness, entirely from the portal's own Postgres.
app.get("/settings/billing-data", async (req, res, next) => {
  try {
    const pa = await isPlatformAdmin(req.identity.email);
    if (!pa) return res.status(403).send(page403(req, "Platform-admin only."));
    const [cost, usage, coverage] = await Promise.all([
      repo.latestCostSnapshot(),
      repo.latestUsageSnapshot(),
      repo.snapshotCoverage(),
    ]);
    const content = v.billingDataSection({ cost, usage, coverage });
    render(res, req, { title: "Billing & data", body: v.settingsPage({ active: "billing-data", content, isPlatformAdmin: true }), isPlatformAdmin: true });
  } catch (e) {
    next(e);
  }
});

// Old bookmark: the platform-admins screen now lives under Settings.
app.get("/platform-admins", (_req, res) => res.redirect(301, "/settings/platform-admins"));

app.post("/platform-admins/add", async (req, res, next) => {
  try {
    const pa = await isPlatformAdmin(req.identity.email);
    if (!pa) return res.status(403).send(page403(req, "Platform-admin only."));
    if (req.body.email) await repo.addPlatformAdmin(req.identity.email, req.body.email);
    res.redirect("/settings/platform-admins");
  } catch (e) {
    next(e);
  }
});

app.post("/platform-admins/remove", async (req, res, next) => {
  try {
    const pa = await isPlatformAdmin(req.identity.email);
    if (!pa) return res.status(403).send(page403(req, "Platform-admin only."));
    const ok = req.body.email ? await repo.removePlatformAdmin(req.identity.email, req.body.email) : true;
    if (!ok) return res.status(409).send(page403(req, "Refusing to delete the last platform admin - the registry would be unrecoverable."));
    res.redirect("/settings/platform-admins");
  } catch (e) {
    next(e);
  }
});

// --- Error handler ----------------------------------------------------------
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, _next) => {
  log.error("unhandled error", { message: err.message, stack: err.stack, traceId: traceOf(req) });
  if (res.headersSent) return;
  res.status(500).type("html").send(
    v.layout({ title: "Error", body: v.errorPage(500, "Something went wrong."), user: req.identity?.email || "" }),
  );
});

// --- Boot -------------------------------------------------------------------
async function main() {
  await migrate();
  await seed({
    platformCards: [
      {
        slug: "portal",
        name: "Admin Portal",
        description: "The platform control plane: registry, deploy dispatch, cost and usage showback.",
        icon: "compass",
        hostname: process.env.PORTAL_HOSTNAME || `portal.${APP_DOMAIN}`,
      },
      {
        slug: "outline",
        name: "Outline",
        description: "The team wiki: docs, guides and shared knowledge, behind the same SSO.",
        icon: "book",
        hostname: process.env.OUTLINE_HOSTNAME || `outline.${APP_DOMAIN}`,
        // Platform-updatable: the scheduler watches this repo's releases and the card
        // gains the Updates panel (image-only updates via update-platform-app.yml).
        upstreamRepo: "outline/outline",
      },
    ],
    bootstrapAdmin: process.env.PORTAL_BOOTSTRAP_ADMIN || "",
  });
  app.listen(PORT, "0.0.0.0", () => log.info("portal listening", { port: PORT }));
}

main().catch((err) => {
  log.error("boot failed", { message: err.message, stack: err.stack });
  process.exit(1);
});
