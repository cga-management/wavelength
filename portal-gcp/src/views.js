// Server-rendered HTML. No client framework: server-rendered pages get re-auth free
// behind IAP (template issue #21 documents the SPA-behind-IAP session-expiry pain). One
// small shared stylesheet (public/style.css). Everything user-controlled is escaped.

import { describeCron, nextFire } from "./cron.js";

export function esc(s) {
  if (s === null || s === undefined) return "";
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// href values must be http(s): esc() stops HTML injection but not a javascript: scheme.
// Writes are validated in server.js; this render-time guard also covers rows written
// out-of-band (defence in depth).
function safeDocsUrl(raw) {
  return raw && /^https?:\/\//i.test(raw) ? raw : "";
}

function icon(app) {
  const v = app.icon || "";
  if (/^https?:\/\//i.test(v)) return `<img class="icon" src="${esc(v)}" alt="">`;
  const glyph = v || (app.name || "?").trim().charAt(0).toUpperCase();
  return `<span class="icon glyph">${esc(glyph)}</span>`;
}

function statusBadge(app) {
  if (app.status === "deployed") return "";
  const cls = app.status === "archived" ? "badge archived" : "badge pending";
  const label = app.status === "archived" ? "archived" : "pending";
  return `<span class="${cls}">${label}</span>`;
}

// Brand chrome is configurable (Settings > Branding). Absent keys fall back to these.
export const BRAND_DEFAULTS = { name: "Wavelength", tagline: "control plane", icon: "" };

// Resolve the stored platform_settings map into the brand shown in the chrome. A wholly
// absent key uses the default; an admin who deliberately cleared the tagline gets no
// tagline (empty is honored). A blank name falls back - a nameless brand is broken.
export function brandFrom(settings = {}) {
  const name = (settings.brand_name || "").trim() ? settings.brand_name : BRAND_DEFAULTS.name;
  const tagline = settings.brand_tagline !== undefined ? settings.brand_tagline : BRAND_DEFAULTS.tagline;
  return { name, tagline, icon: settings.brand_icon || "" };
}

// The default brand mark: a sine wave in a rounded square. Inline SVG so the top-bar
// copy follows the theme via currentColor; the favicon variant carries a fixed
// theme-neutral stroke (currentColor does not resolve inside a favicon).
function defaultBrandSvg(stroke) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" fill="none"><rect x="36" y="36" width="440" height="440" rx="92" stroke="${stroke}" stroke-width="40"/><path d="M104 296 C 138 168, 216 168, 256 256 C 296 344, 374 344, 408 264" stroke="${stroke}" stroke-width="40" stroke-linecap="round"/></svg>`;
}

// Brand icon, same convention as app card icon(): http(s) URL -> small rounded image,
// any other non-empty value -> text/emoji glyph, empty -> the default wave mark.
function brandIconHtml(iconVal) {
  if (!iconVal) return `<span class="brand-icon svgmark">${defaultBrandSvg("currentColor")}</span>`;
  if (/^https?:\/\//i.test(iconVal)) return `<img class="brand-icon" src="${esc(iconVal)}" alt="">`;
  return `<span class="brand-icon glyph">${esc(iconVal)}</span>`;
}

// Favicon link for the configured icon: an image URL is used directly; an emoji is wrapped
// in an inline SVG data URI (URL-encoded so it is attribute-safe); unset uses the default
// wave mark in a mid-grey that reads on both light and dark tab bars.
function faviconLink(iconVal) {
  if (!iconVal) return `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(defaultBrandSvg("#7a828c"))}">`;
  if (/^https?:\/\//i.test(iconVal)) return `<link rel="icon" href="${esc(iconVal)}">`;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><text y=".9em" font-size="90">${esc(iconVal)}</text></svg>`;
  return `<link rel="icon" href="data:image/svg+xml,${encodeURIComponent(svg)}">`;
}

export function layout({ title, body, user, isPlatformAdmin, branding }) {
  const b = brandFrom(branding || {});
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)} - ${esc(b.name)}</title>
${faviconLink(b.icon)}
<script>
// Apply the saved theme choice before the stylesheet paints, so there is no flash.
// "wl-theme" is "light" | "dark"; missing (or anything else) means follow the system.
(function () {
  try {
    var t = localStorage.getItem("wl-theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch (e) {}
})();
</script>
<link rel="stylesheet" href="/style.css">
<script src="/time.js" defer></script>
</head>
<body>
<header class="topbar">
  <a class="brand" href="/">${brandIconHtml(b.icon)}${esc(b.name)}${b.tagline ? ` <span>${esc(b.tagline)}</span>` : ""}</a>
  <nav>
    <a href="/">Apps</a>
    <a class="btn primary add-app" href="/onboard">+ Add app</a>
    ${isPlatformAdmin ? `<a href="/portfolio">Reports</a>` : ""}
    <a class="gear" href="/settings" title="Settings" aria-label="Settings">&#9881;</a>
    <span class="who" title="${esc(user || "")}">${esc(user || "")}</span>
  </nav>
</header>
<main>
${body}
</main>
</body>
</html>`;
}

export function flash(msg, kind = "info") {
  if (!msg) return "";
  return `<div class="flash ${esc(kind)}">${esc(msg)}</div>`;
}

export function grid(apps, ctx) {
  if (apps.length === 0) {
    return `<p class="empty">No apps are visible to you yet. <a href="/register">Register one</a>.</p>`;
  }
  const cards = apps
    .map((app) => {
      const openable = app.status === "deployed" && app.hostname;
      // The card itself is the launcher: the stretched title link opens the app.
      // Management (edit, deploy, cost/usage) is the exception, tucked behind the
      // small Details link. Non-openable cards fall back to the detail page.
      const primaryHref = openable ? `https://${esc(app.hostname)}` : `/app/${app.id}`;
      const details = openable ? `<a class="details" href="/app/${app.id}">Details &rarr;</a>` : "";
      const docs = safeDocsUrl(app.docs_url) ? `<a class="docs" href="${esc(app.docs_url)}" target="_blank" rel="noopener">Docs</a>` : "";
      // Platform-updatable card with a newer upstream release than the portal last
      // rolled: a small nudge (the version number is public upstream data).
      const updateBadge = app.upstream_repo && app.available_version && app.current_version
        && app.available_version !== app.current_version
        ? ` <span class="badge update">update available</span>` : "";
      return `<article class="card ${esc(app.status)}">
        <div class="card-head">${icon(app)}<h2><a class="card-title" href="${primaryHref}">${esc(app.name)}</a> ${statusBadge(app)}${updateBadge}</h2></div>
        <p class="desc">${esc(app.description || "")}</p>
        <div class="card-foot"><span class="slug">${esc(app.slug)}</span>${docs}${details}</div>
      </article>`;
    })
    .join("\n");
  return `<div class="grid">${cards}</div>`;
}

function money(n, currency) {
  if (n === null || n === undefined) return "-";
  const cur = currency || "GBP";
  try {
    return new Intl.NumberFormat("en-GB", { style: "currency", currency: cur }).format(Number(n));
  } catch {
    return `${cur} ${Number(n).toFixed(2)}`;
  }
}

function sumValues(obj) {
  return Object.values(obj || {}).reduce((a, b) => (typeof b === "number" ? a + b : a), 0);
}

// Cost panel: three visually distinct tiers - attributed (fact), apportioned (estimated),
// AI spend (gateway source of truth). Renders "no data yet" honestly when empty.
export function costPanel(cost) {
  if (!cost) {
    return `<section class="panel cost"><h3>Cost</h3><p class="nodata">No cost data yet. The collector writes a snapshot once the billing export has rows (about a day after standup).</p></section>`;
  }
  const cur = cost.currency;
  const attr = cost.attributed || {};
  const app = cost.apportioned || {};
  const ai = cost.ai_spend || {};
  const attrRows = Object.entries(attr).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${money(v, cur)}</td></tr>`).join("") || `<tr><td colspan="2" class="nodata">none</td></tr>`;
  const appRows = Object.entries(app).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${money(v, cur)}</td></tr>`).join("") || `<tr><td colspan="2" class="nodata">none</td></tr>`;
  const aiTotal = ai.total;
  return `<section class="panel cost">
    <h3>Cost <span class="period">${esc(cost.period_start)} to ${esc(cost.period_end)}</span></h3>
    <div class="tier attributed"><h4>Attributed <small>billing rows - fact</small></h4>
      <table>${attrRows}<tr class="subtotal"><td>subtotal</td><td>${money(sumValues(attr), cur)}</td></tr></table></div>
    <div class="tier apportioned"><h4>Apportioned <small>estimated (shared floor)</small></h4>
      <table>${appRows}<tr class="subtotal"><td>subtotal</td><td>${money(sumValues(app), cur)}</td></tr></table></div>
    <div class="tier ai"><h4>AI spend <small>gateway usage log</small></h4>
      ${aiTotal !== undefined ? `<table><tr><td>total</td><td>${money(aiTotal, cur)}</td></tr></table>` : `<p class="nodata">No AI spend recorded (gateway not deployed).</p>`}</div>
  </section>`;
}

// Usage panel: aggregate-only (counts, never who). "no data yet" when empty.
export function usagePanel(usage) {
  const has = usage && Object.keys(usage).length > 0;
  if (!has) {
    return `<section class="panel usage"><h3>Usage</h3><p class="nodata">No usage data yet. The collector aggregates LB and IAP logs once the sink has entries.</p></section>`;
  }
  const cell = (w, field) => (usage[w] && usage[w][field] !== null && usage[w][field] !== undefined ? esc(usage[w][field]) : "-");
  return `<section class="panel usage">
    <h3>Usage <small>aggregate-only</small></h3>
    <table class="usage-table">
      <thead><tr><th></th><th>48h</th><th>7d</th><th>30d</th></tr></thead>
      <tbody>
        <tr><td>Unique users</td><td>${cell("48h","unique_users")}</td><td>${cell("7d","unique_users")}</td><td>${cell("30d","unique_users")}</td></tr>
        <tr><td>Avg users/day</td><td>${cell("48h","avg_users_per_day")}</td><td>${cell("7d","avg_users_per_day")}</td><td>${cell("30d","avg_users_per_day")}</td></tr>
        <tr><td>Requests</td><td>${cell("48h","requests")}</td><td>${cell("7d","requests")}</td><td>${cell("30d","requests")}</td></tr>
        <tr><td>Uptime %</td><td>${cell("48h","uptime_pct")}</td><td>${cell("7d","uptime_pct")}</td><td>${cell("30d","uptime_pct")}</td></tr>
      </tbody>
    </table>
  </section>`;
}

// --- Runtime logs panel (docs/portal.md, third sanctioned deviation) ---------
// Read-only, newest-first, aggregate over the app's ONE Cloud Run service. Everything is
// escaped and the table scrolls horizontally so a long line never breaks the page. Filter
// and Refresh links point back at `selfBase` (the detail page or the standalone logs page),
// so no client JS is needed.
const LOG_SEVERITIES = ["DEFAULT", "INFO", "WARNING", "ERROR"];

function shortTs(ts) {
  if (!ts) return "-";
  const d = new Date(ts);
  if (isNaN(d.getTime())) return String(ts);
  // "YYYY-MM-DD HH:MM:SS UTC", milliseconds dropped. The zone is spelled out because
  // this string must stand alone (the no-JS fallback, <option> text).
  return d.toISOString().replace("T", " ").replace(/\.\d+Z$/, " UTC");
}

// Every human-facing timestamp renders through this: a <time> element carrying the exact
// UTC instant, fallback text explicitly labelled UTC. public/time.js (loaded by the
// layout) rewrites these to the viewer's local zone with a short zone suffix, keeping
// the UTC string on title; without JS the UTC fallback stands. Machine surfaces (dump
// object names, audit rows, logs' own content) deliberately do NOT use this - they stay
// raw UTC (docs/portal.md, "Time and timezones").
function timeEl(ts) {
  if (!ts) return "-";
  const d = ts instanceof Date ? ts : new Date(ts);
  if (isNaN(d.getTime())) return esc(String(ts));
  return `<time datetime="${d.toISOString()}">${shortTs(d)}</time>`;
}

function logSeverityBadge(sev) {
  const s = (sev || "DEFAULT").toUpperCase();
  const cls = s === "ERROR" || s === "CRITICAL" || s === "ALERT" || s === "EMERGENCY"
    ? "error"
    : s === "WARNING"
      ? "warning"
      : s === "INFO" || s === "NOTICE"
        ? "info"
        : "default";
  return `<span class="log-sev ${cls}">${esc(s)}</span>`;
}

export function logsPanel({ service, result, severity, selfBase }) {
  const cur = severity && LOG_SEVERITIES.includes(severity) ? severity : "DEFAULT";
  const link = (sev, label) => {
    const active = cur === sev ? " active" : "";
    const q = sev === "DEFAULT" ? "" : `?sev=${encodeURIComponent(sev)}`;
    return `<a class="sevfilter${active}" href="${selfBase}${q}">${esc(label)}</a>`;
  };
  const refreshHref = `${selfBase}${cur === "DEFAULT" ? "" : `?sev=${encodeURIComponent(cur)}`}`;
  const controls = `<div class="logs-controls">
    <span class="sevfilters">${link("DEFAULT", "All")}${link("INFO", "Info+")}${link("WARNING", "Warning+")}${link("ERROR", "Error")}</span>
    <a class="btn refresh" href="${refreshHref}">Refresh</a>
  </div>`;

  let body;
  if (result.error) {
    body = `<p class="nodata logs-error">${esc(result.error)}</p>`;
  } else if (!result.entries || result.entries.length === 0) {
    body = `<p class="nodata">No log entries for <code>${esc(service)}</code>${cur === "DEFAULT" ? "" : ` at severity ${esc(cur)} or higher`} in the recent window.</p>`;
  } else {
    const rows = result.entries
      .map((e) => `<tr>
        <td class="log-ts">${timeEl(e.timestamp)}</td>
        <td>${logSeverityBadge(e.severity)}</td>
        <td class="log-msg">${esc(e.message)}</td>
      </tr>`)
      .join("");
    body = `<div class="logs-scroll"><table class="logs-table">
      <thead><tr><th>Time</th><th>Severity</th><th>Message</th></tr></thead>
      <tbody>${rows}</tbody></table></div>`;
  }

  return `<section class="panel logs">
    <h3>Logs <span class="period">${esc(service)}</span></h3>
    ${controls}
    ${body}
  </section>`;
}

// Standalone logs page (GET /app/:id/logs): the same panel with its own URL, so a filtered
// or refreshed view is bookmarkable and reloads only the logs, not the whole detail page.
export function logsPage({ app, service, result, severity, selfBase }) {
  return `<a class="back" href="/app/${app.id}">&larr; Back to ${esc(app.name)}</a>
  <div class="detail-head">${icon(app)}<h1>${esc(app.name)} logs ${statusBadge(app)}</h1></div>
  <p class="desc">Recent runtime logs for this app's Cloud Run service, newest first. Read-only.</p>
  ${logsPanel({ service, result, severity, selfBase })}`;
}

function deploymentRow(d) {
  return `<tr class="dep ${esc(d.status)}">
    <td>${timeEl(d.created_at)}</td>
    <td>${d.kind === "platform_update" ? "update" : d.kind === "restore" ? "restore" : "deploy"}</td>
    <td>${esc(d.ref)}</td>
    <td>${esc(d.sha ? String(d.sha).slice(0, 7) : "-")}</td>
    <td><span class="dep-status ${esc(d.status)}">${esc(d.status)}</span></td>
  </tr>`;
}

// --- Backups panel (portal-managed backups) -----------------------------------
// Read-only reassurance for the app's owner and admins: the instance-protection line
// (nightly backups + PITR, live from the Cloud SQL Admin API) and the app's dumps with
// their deploy pairing. Platform admins additionally get the per-dump restore/delete
// actions (typed confirmation: the admin types the app slug, re-checked server-side)
// and the pinned-deploy picker. Sizes human-readable, times via timeEl (UTC at rest,
// local at the glass), heads 7 chars. Dump OBJECT NAMES keep their embedded UTC stamp
// untouched - they are copy-paste machine surfaces, not display timestamps.

function humanSize(n) {
  const v0 = Number(n);
  if (n === null || n === undefined || isNaN(v0)) return "-";
  const units = ["B", "KB", "MB", "GB", "TB"];
  let v = v0;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${i === 0 ? v : v.toFixed(1)} ${units[i]}`;
}

// "taken before deploy #n (sha)" + "matching code: deploy #n-1 (sha)". `estimated`
// marks the timestamp fallback for dumps that predate the metadata stamp.
function backupPairing(d) {
  const approx = d.estimated ? ` <small>(by timestamp)</small>` : "";
  const taken = !d.taken
    ? `<span class="nodata">pairing unknown</span>`
    : d.taken.kind === "deploy"
      ? `taken before deploy #${d.taken.n} (${esc(d.taken.head)})${approx}`
      : `taken before a restore${approx}`;
  const matching = d.matching
    ? `matching code: deploy #${d.matching.n} (${esc(d.matching.head)})`
    : `matching code: no earlier successful deploy`;
  return `${taken}<br><small>${matching}</small>`;
}

// Per-dump admin actions: restore and delete each in their OWN form with their own
// typed-confirmation field (never one form with two submit buttons - the Enter key
// must not be able to fire the wrong destructive action).
function backupActions(app, d, { tokenOk, activeDep }) {
  const confirmField = `<input name="confirm" required pattern="${esc(app.slug)}" placeholder="type ${esc(app.slug)}" title="type the app slug to confirm">`;
  const restore = app.status === "archived"
    ? `<p class="note">restore the app first</p>`
    : !tokenOk
      ? `<p class="note">dispatch token not configured</p>`
      : activeDep
        ? `<p class="note">a run is in progress</p>`
        : `<form method="post" action="/app/${app.id}/backups/restore" class="inline">
            <input type="hidden" name="object" value="${esc(d.object)}">
            ${confirmField}
            <button class="btn" type="submit">Restore</button>
          </form>`;
  const del = `<form method="post" action="/app/${app.id}/backups/delete" class="inline">
      <input type="hidden" name="object" value="${esc(d.object)}">
      ${confirmField}
      <button class="btn danger" type="submit">Delete</button>
    </form>`;
  return `<details class="backup-actions"><summary>actions</summary>${restore}${del}</details>`;
}

function backupRow(app, d, { canAct, tokenOk, activeDep }) {
  const label = d.preRestore ? `<br><span class="badge pending">pre-restore safety dump</span>` : "";
  return `<tr>
    <td title="${esc(d.object)}">${esc(d.base)}${label}</td>
    <td>${timeEl(d.timeCreated)}</td>
    <td>${esc(humanSize(d.size))}</td>
    <td>${backupPairing(d)}</td>
    ${canAct ? `<td>${backupActions(app, d, { tokenOk, activeDep })}</td>` : ""}
  </tr>`;
}

// "Deploy a previous head": redeploy any sha this app already deployed successfully,
// via the ordinary deploy workflow with ref = the exact sha. Platform admins only.
function pinnedDeployPicker(app, pinned, { tokenOk, activeDep }) {
  if (!app.repo || app.status === "archived") return "";
  if (!pinned || pinned.length === 0) return "";
  if (!tokenOk) return `<p class="note">Dispatch token not configured; pinned deploys are unavailable.</p>`;
  if (activeDep) return `<p class="note">A run is in progress (${esc(activeDep.status)}); the pinned-deploy picker returns when it finishes.</p>`;
  const opts = pinned
    .map((p) => `<option value="${esc(p.sha)}">${esc(String(p.sha).slice(0, 7))} - ${esc(String(p.ref || "?").slice(0, 7))} - ${esc(shortTs(p.created_at))}</option>`)
    .join("");
  return `<form method="post" action="/app/${app.id}/backups/deploy-pinned" class="inline pinned-deploy">
    <label>Deploy a previous head
      <select name="sha" required>
        <option value="">pick a successful deploy...</option>
        ${opts}
      </select>
    </label>
    <button class="btn" type="submit">Deploy this head</button>
  </form>
  <p class="note">Redeploys the exact commit of a previous successful deploy. Pair it with the matching dump above to roll code and data back together.</p>`;
}

export function backupsPanel({ app, view, perms, tokenOk, activeDep }) {
  if (!view) return "";
  if (!view.configured) {
    return `<section class="panel backups"><h3>Backups</h3><p class="nodata">Backups are not configured on this instance.</p></section>`;
  }
  const prot = view.protection || {};
  const onOff = (b) => (b ? "on" : "OFF");
  const protLine = prot.error
    ? `<p class="nodata">Instance protection: ${esc(prot.error)}</p>`
    : `<p class="protection">Instance protection: nightly backups <strong>${onOff(prot.backupsEnabled)}</strong>, point-in-time recovery <strong>${onOff(prot.pitrEnabled)}</strong> <small>(live from the Cloud SQL Admin API)</small></p>`;
  const canAct = perms.canRestoreBackup() || perms.canDeleteBackup();
  let table;
  if (view.listError) {
    table = `<p class="nodata">${esc(view.listError)}</p>`;
  } else if (!view.dumps || view.dumps.length === 0) {
    table = `<p class="nodata">No dumps yet. A dump is written to the pre-deploy bucket before every deploy.</p>`;
  } else {
    const rows = view.dumps.map((d) => backupRow(app, d, { canAct, tokenOk, activeDep })).join("");
    table = `<table class="backups-table">
      <thead><tr><th>Dump</th><th>Taken</th><th>Size</th><th>Deploy pairing</th>${canAct ? "<th></th>" : ""}</tr></thead>
      <tbody>${rows}</tbody></table>`;
  }
  const picker = perms.canDeployPinned() ? pinnedDeployPicker(app, view.pinned, { tokenOk, activeDep }) : "";
  return `<section class="panel backups">
    <h3>Backups</h3>
    ${protLine}
    ${table}
    ${picker}
  </section>`;
}

// --- Deploy schedules panel ---------------------------------------------------
// One-off and recurring schedules for this app. The human reading of a cron is ALWAYS
// derived from the stored string (describeCron) - never a second hand-maintained copy.

// Next few fire instants of a stored cron (UTC, via cron.js's nextFire), so the row can
// preview them through timeEl and the viewer sees them in their own zone. An
// unparseable stored cron renders without a preview rather than erroring the page.
function upcomingFires(cron, n = 3) {
  const out = [];
  try {
    let from = new Date();
    for (let i = 0; i < n; i++) {
      from = nextFire(cron, from);
      out.push(from);
    }
  } catch {
    // fall through: no preview
  }
  return out;
}

function scheduleRow(app, s, perms, email) {
  const fires = s.cadence === "recurring" && s.status === "active" ? upcomingFires(s.cron) : [];
  const preview = fires.length
    ? `<br><small>next: ${fires.map((f) => timeEl(f)).join(", ")}</small>`
    : "";
  const when = s.cadence === "once"
    ? `once at ${timeEl(s.run_at)}`
    : `<code>${esc(s.cron)}</code> <small>${esc(describeCron(s.cron))}</small>${preview}`;
  const what = s.kind === "platform_update"
    ? `update to ${esc((s.payload && s.payload.image_tag) || "?")}`
    : "deploy";
  const next = s.status === "active" ? timeEl(s.next_fire_at) : "-";
  const last = s.last_fired_at
    ? `${timeEl(s.last_fired_at)}${s.last_result ? ` <small>${esc(s.last_result)}</small>` : ""}`
    : "-";
  const status = `<span class="sched-status ${esc(s.status)}">${esc(s.status)}</span>${s.disabled_reason ? `<br><small>${esc(s.disabled_reason)}</small>` : ""}`;
  const cancel = s.status === "active" && (perms.platformAdmin || s.created_by === email)
    ? `<form method="post" action="/app/${app.id}/schedule/${s.id}/cancel" class="inline"><button class="linkbtn">cancel</button></form>`
    : "";
  return `<tr>
    <td>${what}<br><small>${esc(s.created_by)}</small></td>
    <td>${when}</td>
    <td>${next}</td>
    <td>${last}</td>
    <td>${status}</td>
    <td>${cancel}</td>
  </tr>`;
}

function scheduleForm(app, action, { availableVersion } = {}) {
  const isUpdate = action === "update";
  const tagField = isUpdate
    ? `<label>Image tag <input name="image_tag" required pattern="v?\\d+\\.\\d+\\.\\d+" value="${esc(availableVersion || "")}" placeholder="1.2.3"></label>`
    : "";
  return `<details class="sched-new">
    <summary>${isUpdate ? "Schedule an update" : "Schedule a deploy"}</summary>
    <form method="post" action="/app/${app.id}/schedule" class="form sched-form">
      <input type="hidden" name="action" value="${esc(action)}">
      ${tagField}
      <label>Cadence
        <select name="cadence">
          <option value="once">One-off</option>
          <option value="recurring">Recurring (cron)</option>
        </select>
      </label>
      <label>Run at <input type="datetime-local" name="run_at_local" data-utc-field="run_at"><small>one-off only. Times shown in <span data-tz-name>your local zone (a one-off needs JavaScript to submit)</span>.</small></label>
      <input type="hidden" name="run_at" value="">
      <p class="note" data-utc-echo hidden></p>
      <label>Cron (UTC) <input name="cron" placeholder="0 2 * * 1"><small>recurring only: minute hour day month weekday, evaluated in UTC. "0 2 * * 1" = Mondays 02:00 UTC. Minimum interval 15 minutes.</small></label>
      <button class="btn" type="submit">${isUpdate ? "Schedule update" : "Schedule deploy"}</button>
    </form>
  </details>`;
}

// --- Platform-app updates panel (platform admins, apps with upstream_repo) ----
// Detect + approve: the scheduler surfaces the latest upstream release here; a human
// triggers the image-only update now or schedules it. current_version is what the
// PORTAL last rolled - the committed tfvars in the platform repo stays the record.

function updatePanel({ app, activeDep, tokenOk }) {
  const cur = app.current_version;
  const avail = app.available_version;
  const updateAvailable = !!(avail && cur && avail !== cur);
  const checked = app.version_checked_at ? `checked ${ago(app.version_checked_at)}` : "not checked yet";

  let form;
  if (!tokenOk) {
    form = `<p class="note">Dispatch token not configured; updates are unavailable.</p>`;
  } else if (activeDep) {
    form = `<button class="btn" disabled>Update now</button>
            <p class="note">A run is in progress (${esc(activeDep.status)}); wait for it to finish.</p>`;
  } else {
    form = `<form method="post" action="/app/${app.id}/update" class="inline">
      <input name="image_tag" required pattern="v?\\d+\\.\\d+\\.\\d+" title="release tag like 1.2.3" value="${esc(avail || "")}" placeholder="1.2.3">
      <button class="btn primary" type="submit">Update now</button>
    </form>`;
  }

  return `<section class="panel updates">
    <h3>Updates <span class="period">${esc(app.upstream_repo)}</span></h3>
    ${updateAvailable ? `<p class="flash info">Update available: <strong>${esc(avail)}</strong></p>` : ""}
    <dl class="meta">
      <dt>Current version</dt><dd>${cur ? esc(cur) : `not yet tracked by the portal <small>(the committed tfvars in the platform repo is the record)</small>`}</dd>
      <dt>Latest upstream release</dt><dd>${avail ? esc(avail) : "-"} <small>${esc(checked)}</small></dd>
    </dl>
    ${form}
    <p class="note">Image-only update: the workflow mirrors the release into Artifact Registry, rolls the Cloud Run service (rolling back if the new revision is unhealthy), and commits the tag bump to the platform repo. Recurring updates live in the Schedules panel.</p>
  </section>`;
}

export function schedulesPanel({ app, schedules, perms, email, tokenOk }) {
  const canScheduleDeploy = !!app.repo && app.ever_deployed && app.status !== "archived" && perms.canRedeploy();
  const canScheduleUpdate = !!app.upstream_repo && app.status !== "archived" && perms.platformAdmin;
  if (!canScheduleDeploy && !canScheduleUpdate) return "";

  const rows = (schedules || []).map((s) => scheduleRow(app, s, perms, email)).join("");
  const table = rows
    ? `<table class="schedules"><thead><tr><th>What</th><th>Schedule</th><th>Next fire</th><th>Last fired</th><th>Status</th><th></th></tr></thead><tbody>${rows}</tbody></table>`
    : `<p class="nodata">No schedules.</p>`;
  const forms = tokenOk
    ? `${canScheduleDeploy ? scheduleForm(app, "deploy") : ""}
       ${canScheduleUpdate ? scheduleForm(app, "update", { availableVersion: app.available_version }) : ""}`
    : `<p class="note">Dispatch token not configured; scheduling is unavailable.</p>`;
  return `<section class="panel schedules-panel">
    <h3>Schedules</h3>
    ${table}
    ${forms}
    <p class="note">The scheduler runs every few minutes; a one-off fires within about 5 minutes of its time. Recurring crons are evaluated in UTC; times display in your zone. Fires are re-authorized against the creator's current permissions.</p>
  </section>`;
}

export function cardDetail({ app, perms, admins, deployments, schedules, cost, usage, deployEnabled, deployNote, logsView, backupsView, tokenOk }) {
  const isFirstDeploy = app.status === "registered";
  const canDeploy = isFirstDeploy ? perms.canFirstDeploy() : perms.canRedeploy();
  const deployLabel = isFirstDeploy ? "Deploy (first deploy / approve)" : "Redeploy";
  const linkOnly = !app.repo;

  const activeDep = deployments.find((d) => d.status === "dispatched" || d.status === "running");
  const deployBtn = () => {
    if (linkOnly) {
      return app.upstream_repo
        ? `<p class="note">Platform-managed app: updated via the Updates panel below, not deployed from a repo.</p>`
        : `<p class="note">Link-only card (no repo): platform-managed, no deploy button.</p>`;
    }
    if (!canDeploy) {
      return isFirstDeploy
        ? `<p class="note">First deploy is a platform-admin action (the vetting gate).</p>`
        : `<p class="note">Redeploy is limited to this app's admins.</p>`;
    }
    if (!deployEnabled) {
      return `<button class="btn" disabled title="${esc(deployNote)}">${esc(deployLabel)}</button>
              <p class="note">${esc(deployNote)}</p>`;
    }
    if (activeDep) {
      return `<button class="btn" disabled>${esc(deployLabel)}</button>
              <p class="note">A deployment is in progress (${esc(activeDep.status)}); wait for it to finish.</p>`;
    }
    return `<form method="post" action="/app/${app.id}/deploy" class="inline">
        <input type="hidden" name="csrf" value="">
        <button class="btn primary" type="submit">${esc(deployLabel)}</button>
      </form>`;
  };

  const meta = `<dl class="meta">
    <dt>Slug</dt><dd>${esc(app.slug)}${app.ever_deployed ? ` <small>(immutable - deployed)</small>` : ""}</dd>
    <dt>Hostname</dt><dd>${app.status === "deployed" ? `<a href="https://${esc(app.hostname)}" target="_blank" rel="noopener">${esc(app.hostname)}</a>` : esc(app.hostname)}</dd>
    <dt>Repo</dt><dd>${esc(app.repo || "(link-only)")}</dd>
    <dt>Ref</dt><dd>${esc(app.ref || "-")}</dd>
    <dt>Owner</dt><dd>${esc(app.owner_email)}</dd>
    <dt>Status</dt><dd>${esc(app.status)}${app.archive_reason ? ` - ${esc(app.archive_reason)}` : ""}</dd>
    <dt>Docs</dt><dd>${safeDocsUrl(app.docs_url) ? `<a href="${esc(app.docs_url)}" target="_blank" rel="noopener">${esc(app.docs_url)}</a>` : "-"}</dd>
  </dl>`;

  const depTable = deployments.length
    ? `<table class="deployments"><thead><tr><th>When</th><th>Kind</th><th>Ref</th><th>SHA</th><th>Status</th></tr></thead><tbody>${deployments.map(deploymentRow).join("")}</tbody></table>`
    : `<p class="nodata">No deployments recorded.</p>`;

  // Admin controls (edit / archive / admins / owner transfer) shown per entitlement.
  let controls = "";
  if (perms.canEditMetadata()) {
    controls += `<a class="btn" href="/app/${app.id}/edit">Edit metadata</a>`;
  }
  if (perms.canArchiveRestore()) {
    if (app.status === "archived") {
      controls += `<form method="post" action="/app/${app.id}/restore" class="inline"><button class="btn">Restore</button></form>`;
    } else {
      controls += `<form method="post" action="/app/${app.id}/archive" class="inline archive-form">
        <input name="reason" placeholder="reason (required)" required>
        <button class="btn danger">Archive</button></form>`;
    }
  }

  let adminMgmt = "";
  if (perms.canManageAppAdmins()) {
    const rows = admins.map((a) => `<li>${esc(a.email)} <small>${esc(a.added_by)}</small>
      <form method="post" action="/app/${app.id}/admins/remove" class="inline">
        <input type="hidden" name="email" value="${esc(a.email)}"><button class="linkbtn">remove</button></form></li>`).join("");
    adminMgmt = `<section class="panel"><h3>App admins</h3>
      <ul class="admins">${rows}</ul>
      <form method="post" action="/app/${app.id}/admins/add" class="inline">
        <input name="email" type="email" placeholder="email" required><button class="btn">Add admin</button></form>
      <form method="post" action="/app/${app.id}/owner" class="inline">
        <input name="email" type="email" placeholder="new owner email" required><button class="btn">Transfer ownership</button></form>
    </section>`;
  } else {
    const rows = admins.map((a) => `<li>${esc(a.email)}</li>`).join("");
    adminMgmt = `<section class="panel"><h3>App admins</h3><ul class="admins">${rows}</ul></section>`;
  }

  const showCostUsage = perms.canSeeCostUsage();

  return `<a class="back" href="/">&larr; All apps</a>
  <div class="detail-head">${icon(app)}<h1>${esc(app.name)} ${statusBadge(app)}</h1></div>
  <p class="desc big">${esc(app.description || "")}</p>
  <div class="actions">${deployBtn()}${controls}</div>
  ${app.upstream_repo && perms.platformAdmin ? updatePanel({ app, activeDep, tokenOk }) : ""}
  <section class="panel"><h3>Details</h3>${meta}</section>
  <section class="panel"><h3>Deployment history</h3>${depTable}</section>
  ${backupsView ? backupsPanel({ app, view: backupsView, perms, tokenOk, activeDep }) : ""}
  ${schedulesPanel({ app, schedules: schedules || [], perms, email: perms.email, tokenOk })}
  ${adminMgmt}
  ${showCostUsage ? costPanel(cost) : ""}
  ${showCostUsage ? usagePanel(usage) : ""}
  ${logsView ? logsPanel(logsView) : ""}`;
}

// The standard card JSON the onboarding wizard asks Claude to emit; pasting it here
// fills the form. Keys match the form field names exactly.
export const CARD_JSON_KEYS = ["name", "slug", "hostname", "repo", "ref", "description", "icon", "docs_url"];

export function registerForm(values = {}, error, cfg = {}) {
  return `<a class="back" href="/">&larr; All apps</a>
  <h1>Register an app</h1>
  <p class="desc">Registration is open to any user. Creating a card grants nothing: the card is a request, visible only to you and platform admins until a platform admin presses Deploy once (the vetting gate). New to this? Start with the <a href="/onboard">onboarding guide</a>.</p>
  ${error ? flash(error, "error") : ""}
  <form method="post" action="/register" class="form">
    <label>Paste from Claude <textarea id="cardjson" rows="3" placeholder='{"name": "My App", "slug": "myapp", ...}'></textarea><small>paste the JSON block the onboarding run printed and the fields below fill themselves - or skip this and type them by hand</small></label>
    <label>Name <input name="name" required value="${esc(values.name)}"></label>
    <label>Slug <input name="slug" required pattern="[a-z0-9][a-z0-9-]*" title="lowercase letters, digits, hyphens" value="${esc(values.slug)}"><small>db name, image name, state prefix. Immutable once deployed.</small></label>
    <label>Hostname <input name="hostname" required value="${esc(values.hostname)}"><small>e.g. myapp.${esc(cfg.appDomain || "")}</small></label>
    <label>Repo <input name="repo" placeholder="${esc(cfg.org || "")}/myapp" value="${esc(values.repo)}"><small>leave blank for a link-only card (no deploy)</small></label>
    <label>Ref <input name="ref" placeholder="main" value="${esc(values.ref)}"></label>
    <label>Description <textarea name="description">${esc(values.description)}</textarea></label>
    <label>Icon <input name="icon" placeholder="emoji or image URL" value="${esc(values.icon)}"></label>
    <label>Docs URL <input name="docs_url" value="${esc(values.docs_url)}"></label>
    <button class="btn primary" type="submit">Register</button>
  </form>
  <script>
    document.getElementById("cardjson").addEventListener("input", function (e) {
      var v; try { v = JSON.parse(e.target.value); } catch (err) { return; }
      var f = e.target.closest("form");
      ${JSON.stringify(CARD_JSON_KEYS)}.forEach(function (k) {
        if (v[k] != null && f.elements[k]) f.elements[k].value = String(v[k]);
      });
      e.target.setCustomValidity("");
    });
  </script>`;
}

// --- Onboarding wizard --------------------------------------------------------
// Three guided steps from "I have an app idea" to a registered card, each with a
// copy-paste prompt for Claude Code. Everything instance-specific (org, domain,
// template repo) is injected from config so the wizard is generated, never stale.
export function onboardWizard(cfg) {
  const { org, appDomain, platformRepo, adminContacts = [] } = cfg;
  const contacts = adminContacts.length ? adminContacts.join(", ") : "a platform admin";
  const cardShape = `{
  "name": "My App",
  "slug": "myapp",
  "hostname": "myapp.${appDomain}",
  "repo": "${org}/myapp",
  "ref": "main",
  "description": "One sentence on what the app does.",
  "icon": "emoji or image URL",
  "docs_url": ""
}`;
  const prompt1 = `Create a private GitHub repository for a new Wavelength platform app in the ${org} org. Ask me for the app's name, derive a short lowercase slug from it (letters, digits, hyphens), then create ${org}/<slug> as a PRIVATE repo with a main branch and push my current project to it (or initialize it fresh if I have no code yet). It must be private: it will hold platform configuration.`;
  const prompt2 = `Install the Wavelength onboard-app skill into this repo and run it.

1. Fetch the skill from the platform repo: https://github.com/${platformRepo} (private - your GitHub credentials from step 1 grant access) - copy the skills/onboard-app directory into .claude/skills/onboard-app in this repo.
2. Follow the skill end to end to make this app platform-ready: root Dockerfile, IAP-JWT identity middleware, shared-database slice with row-level security, secrets as references, and the self-provisioning app stack in iac/ (the iap-lb module comes bundled with the skill).
3. Platform facts you will need: GitHub org ${org}; app hostnames live under ${appDomain} (mine will be <slug>.${appDomain}); region europe-west2; the platform repo is ${platformRepo}.
4. When the skill's definition-of-done checklist passes, print a fenced JSON code block with EXACTLY these keys so I can paste it into the platform portal's register form:

${cardShape}`;
  const prompt0 = `Check that my machine is ready to build an app for the Wavelength platform, and walk me through fixing anything that is not. Check each of these and report a clear pass/fail list:

1. git is installed and has user.name and user.email configured.
2. The GitHub CLI (gh) is installed and authenticated: gh auth status succeeds.
3. My GitHub user is a member of the ${org} org: gh api orgs/${org}/members/$(gh api user -q .login) returns 204. If this fails I need an invite - I cannot fix it myself; tell me to email ${contacts} asking them to invite my GitHub username to the ${org} org, and print my username so I can send it to them.
4. Docker is installed and the daemon responds (docker version).

Talk me through fixing anything fixable (installs, gh auth login), and stop at anything that needs the org admin.`;
  const promptBlock = (id, text) =>
    `<div class="promptbox"><pre id="${id}">${esc(text)}</pre><button type="button" class="btn copy" data-copy="${id}">Copy prompt</button></div>`;

  const steps = [
    {
      n: 0,
      nav: "Setup check",
      title: "One-time setup check",
      body: `
    <p>You need a GitHub account that is a member of the <strong>${esc(org)}</strong> org, the GitHub CLI signed in, and Docker. Claude can fix most of this with you - the one thing it cannot do is org membership, which needs a platform admin to invite you: <strong>${esc(contacts)}</strong>.</p>
    ${promptBlock("p0", prompt0)}`,
    },
    {
      n: 1,
      nav: "Private repo",
      title: "Create a private repo",
      body: `
    <p>Your app needs a private repository in the <strong>${esc(org)}</strong> org - it will hold platform configuration, so it must never be public.</p>
    ${promptBlock("p1", prompt1)}`,
    },
    {
      n: 2,
      nav: "Platform-ready",
      title: "Make the app platform-ready",
      body: `
    <p>The <strong>onboard-app</strong> skill walks Claude through everything the platform requires: containerization, SSO identity, a database slice with row-level security, secrets, and the deployable infrastructure stack. It lives in the platform repo - fetching it is also the access check: the same credentials that let you complete step 1 let you read it. If the fetch fails, sort out your GitHub org access before going further.</p>
    ${promptBlock("p2", prompt2)}
    <p class="note">This is the long step: Claude will work through the skill's checklist with you. At the end it prints the card JSON.</p>`,
    },
    {
      n: 3,
      nav: "Register the card",
      title: "Register the card",
      body: `
    <p>Take the JSON block Claude printed to the <a href="/register">register form</a> and paste it into the top field - it fills everything in. Or type the values by hand.</p>
    <p>Your card starts as a <em>request</em>: visible only to you and platform admins until a platform admin reviews it and presses Deploy once. After that first deploy, you redeploy whenever you push.</p>
    <p><a class="btn primary" href="/register">Ready - register the card</a> <span class="note">(you can always come back to this step later)</span></p>`,
    },
  ];

  const nav = steps
    .map(
      (s) => `<li data-step="${s.n}">
        <input type="checkbox" id="tick-${s.n}" aria-label="Mark step ${s.n} done">
        <a href="#step-${s.n}"><span class="stepno">${s.n}</span> ${esc(s.nav)}</a>
      </li>`,
    )
    .join("\n");
  const sections = steps
    .map((s) => `<section class="step" id="step-${s.n}"><h2><span class="stepno">${s.n}</span> ${esc(s.title)}</h2>${s.body}</section>`)
    .join("\n");

  return `<div class="wizard">
  <aside class="wizard-nav">
    <a class="back" href="/">&larr; All apps</a>
    <ul>${nav}</ul>
  </aside>
  <div class="wizard-body">
    <h1>Onboard an app</h1>
    <p class="desc big">From idea to a card on this portal in three steps (plus a one-time setup check). Each step has a prompt to paste into Claude Code in your project.</p>
    <p class="note">Already platform-ready? Skip to <a href="/register">register</a>.</p>
    ${sections}
  </div>
  </div>

  <script>
    document.querySelectorAll("button.copy").forEach(function (b) {
      b.addEventListener("click", function () {
        navigator.clipboard.writeText(document.getElementById(b.dataset.copy).textContent).then(function () {
          b.textContent = "Copied"; setTimeout(function () { b.textContent = "Copy prompt"; }, 1500);
        });
      });
    });

    // Tick-off state persists per browser; ticking a step jumps to the next unticked one.
    (function () {
      var KEY = "wl-onboard-done";
      var done = {};
      try { done = JSON.parse(localStorage.getItem(KEY)) || {}; } catch (e) {}
      var items = Array.prototype.slice.call(document.querySelectorAll(".wizard-nav li"));
      items.forEach(function (li) {
        var n = li.dataset.step, box = li.querySelector("input");
        if (done[n]) { box.checked = true; li.classList.add("done"); }
        box.addEventListener("change", function () {
          li.classList.toggle("done", box.checked);
          done[n] = box.checked;
          try { localStorage.setItem(KEY, JSON.stringify(done)); } catch (e) {}
          if (box.checked) {
            var next = items.find(function (o) { return !o.querySelector("input").checked; });
            if (next) document.getElementById("step-" + next.dataset.step).scrollIntoView({ behavior: "smooth" });
          }
        });
      });

      // Scroll-spy: highlight the step currently in view.
      if ("IntersectionObserver" in window) {
        var spy = new IntersectionObserver(function (entries) {
          entries.forEach(function (en) {
            if (!en.isIntersecting) return;
            items.forEach(function (li) {
              li.classList.toggle("active", "step-" + li.dataset.step === en.target.id);
            });
          });
        }, { rootMargin: "-20% 0px -60% 0px" });
        document.querySelectorAll(".step").forEach(function (s) { spy.observe(s); });
      }
    })();
  </script>`;
}

export function editForm(app, error) {
  return `<a class="back" href="/app/${app.id}">&larr; Back</a>
  <h1>Edit ${esc(app.name)}</h1>
  ${error ? flash(error, "error") : ""}
  <form method="post" action="/app/${app.id}/edit" class="form">
    <label>Name <input name="name" required value="${esc(app.name)}"></label>
    <label>Description <textarea name="description">${esc(app.description)}</textarea></label>
    <label>Icon <input name="icon" value="${esc(app.icon)}"></label>
    <label>Docs URL <input name="docs_url" value="${esc(app.docs_url)}"></label>
    <label>Ref <input name="ref" value="${esc(app.ref)}"></label>
    <p class="note">Slug and hostname are not editable here (slug is immutable once deployed).</p>
    <button class="btn primary" type="submit">Save</button>
  </form>`;
}

// Portfolio (platform admins only): all apps + cost rollup INCLUDING the explicit
// unattributed remainder line, sorted by staleness (zero unique users first).
export function portfolio({ apps, costs, usage, remainder, credits = 0, currency }) {
  const bySlug = Object.fromEntries(costs.map((c) => [c.slug, c]));
  const staleness = (app) => {
    const u = usage[app.slug] && usage[app.slug]["30d"];
    return u ? Number(u.unique_users) : -1; // no data sorts first as an unknown
  };
  const sorted = [...apps].sort((a, b) => staleness(a) - staleness(b));

  const rows = sorted
    .map((app) => {
      const c = bySlug[app.slug];
      const attr = c ? sumValues(c.attributed) : null;
      const appd = c ? sumValues(c.apportioned) : null;
      const ai = c && c.ai_spend ? c.ai_spend.total : null;
      const u30 = usage[app.slug] && usage[app.slug]["30d"];
      const uu = u30 ? u30.unique_users : "-";
      const up = u30 && u30.uptime_pct !== null && u30.uptime_pct !== undefined ? u30.uptime_pct : "-";
      const candidate = u30 && Number(u30.unique_users) === 0;
      return `<tr class="${candidate ? "archive-candidate" : ""}">
        <td><a href="/app/${app.id}">${esc(app.name)}</a> <span class="slug">${esc(app.slug)}</span></td>
        <td>${esc(app.status)}</td>
        <td>${uu}</td><td>${up}</td>
        <td>${attr === null ? "-" : money(attr, currency)}</td>
        <td>${appd === null ? "-" : money(appd, currency)}</td>
        <td>${ai === null || ai === undefined ? "-" : money(ai, currency)}</td>
      </tr>`;
    })
    .join("");

  const totalAttr = costs.reduce((a, c) => a + sumValues(c.attributed), 0);
  const totalApp = costs.reduce((a, c) => a + sumValues(c.apportioned), 0);
  const totalAi = costs.reduce((a, c) => a + (c.ai_spend && c.ai_spend.total ? Number(c.ai_spend.total) : 0), 0);
  const rem = remainder || 0;
  const grand = totalAttr + totalApp + totalAi + rem;

  return `<a class="back" href="/">&larr; All apps</a>
  <h1>Portfolio</h1>
  <p class="desc">Platform-wide. Sorted by staleness (sustained zero unique users is the archive-candidate signature). The rollup reconciles to the bill: it includes the explicit unattributed remainder.</p>
  <table class="portfolio">
    <thead><tr><th>App</th><th>Status</th><th>Users 30d</th><th>Uptime%</th><th>Attributed</th><th>Apportioned</th><th>AI</th></tr></thead>
    <tbody>${rows || `<tr><td colspan="7" class="nodata">No apps.</td></tr>`}</tbody>
    <tfoot>
      <tr class="unattributed"><td colspan="4">Unattributed remainder <small>everything no label/heuristic claimed</small></td><td>${money(rem, currency)}</td><td></td><td></td></tr>
      ${credits !== 0 ? `<tr class="unattributed"><td colspan="4">Credits applied <small>account credits (free trial/promo) - app figures above are gross consumption</small></td><td>${money(credits, currency)}</td><td></td><td></td></tr>` : ""}
      <tr class="grand"><td colspan="4">Total (reconciles to invoice)</td><td colspan="3">${money(grand + credits, currency)}</td></tr>
    </tfoot>
  </table>`;
}

export function platformAdminsView({ admins, canManage }) {
  const rows = admins
    .map((a) => `<li>${esc(a.email)} <small>added by ${esc(a.added_by || "-")}</small>
      ${canManage ? `<form method="post" action="/platform-admins/remove" class="inline">
        <input type="hidden" name="email" value="${esc(a.email)}"><button class="linkbtn">remove</button></form>` : ""}</li>`)
    .join("");
  return `<a class="back" href="/">&larr; All apps</a>
  <h1>Platform admins</h1>
  <p class="desc">Global. Platform admins can deploy any app, archive/restore, manage admins, and see the portfolio. The portal refuses to delete the last row.</p>
  <ul class="admins">${rows}</ul>
  ${canManage ? `<form method="post" action="/platform-admins/add" class="inline">
    <input name="email" type="email" placeholder="email" required><button class="btn">Add platform admin</button></form>` : ""}`;
}

// --- Settings area ------------------------------------------------------------
// Two-column layout (left sub-nav, right content) mirroring the onboarding wizard.
// The sub-nav hides platform-admin-only sections from non-admins, but the routes
// themselves keep their server-side guards - the nav is convenience, not enforcement.

// The collector's Cloud Scheduler cron, rendered for humans. KEEP IN SYNC with
// portal-gcp/variables.tf `collector_schedule` (default "0 5,13 * * *").
export const COLLECTOR_SCHEDULE_HUMAN = "05:00 and 13:00 UTC daily";

// "N hours ago" style hint for a captured_at timestamp, answering "is this current?".
function ago(ts) {
  if (!ts) return "never";
  const then = new Date(ts).getTime();
  if (isNaN(then)) return String(ts);
  const mins = Math.max(0, Math.round((Date.now() - then) / 60000));
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 48) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

const SETTINGS_SECTIONS = [
  { id: "appearance", href: "/settings", label: "Appearance", adminOnly: false },
  { id: "branding", href: "/settings/branding", label: "Branding", adminOnly: true },
  { id: "platform-admins", href: "/settings/platform-admins", label: "Platform admins", adminOnly: true },
  { id: "billing-data", href: "/settings/billing-data", label: "Billing & data", adminOnly: true },
];

// Wrap section content in the two-column settings shell. `active` is the section id;
// `isPlatformAdmin` decides which sub-nav entries appear. Each section's content is a
// self-contained screen (its own back link + heading), so platformAdminsView drops in
// unchanged and Appearance / Billing match it.
export function settingsPage({ active, content, isPlatformAdmin }) {
  const nav = SETTINGS_SECTIONS.filter((s) => !s.adminOnly || isPlatformAdmin)
    .map((s) => `<li class="${s.id === active ? "active" : ""}"><a href="${s.href}">${esc(s.label)}</a></li>`)
    .join("\n");
  return `<div class="settings">
    <aside class="settings-nav">
      <p class="settings-nav-title">Settings</p>
      <ul>${nav}</ul>
    </aside>
    <div class="settings-body">${content}</div>
  </div>`;
}

// Appearance: theme choice (System / Light / Dark). The only client state in the portal,
// and purely cosmetic. Buttons write localStorage "wl-theme" and set data-theme live; the
// head script in layout() applies the saved choice on every page before paint.
export function appearanceSection() {
  return `<a class="back" href="/">&larr; All apps</a>
  <h1>Appearance</h1>
  <p class="desc">How this portal looks in your browser. This is a per-browser preference, stored only on this device and shared with no one.</p>
  <div class="theme-choice" role="group" aria-label="Theme">
    <button type="button" class="btn" data-theme="system" aria-pressed="false">System</button>
    <button type="button" class="btn" data-theme="light" aria-pressed="false">Light</button>
    <button type="button" class="btn" data-theme="dark" aria-pressed="false">Dark</button>
  </div>
  <p class="note">System follows your operating system's light or dark setting.</p>
  <script>
    (function () {
      var KEY = "wl-theme";
      var root = document.documentElement;
      function current() { try { return localStorage.getItem(KEY) || "system"; } catch (e) { return "system"; } }
      function mark(choice) {
        document.querySelectorAll(".theme-choice button").forEach(function (b) {
          var on = b.dataset.theme === choice;
          b.classList.toggle("active", on);
          b.setAttribute("aria-pressed", on ? "true" : "false");
        });
      }
      function apply(choice) {
        try {
          if (choice === "system") { delete root.dataset.theme; localStorage.removeItem(KEY); }
          else { root.dataset.theme = choice; localStorage.setItem(KEY, choice); }
        } catch (e) {}
        mark(choice);
      }
      document.querySelectorAll(".theme-choice button").forEach(function (b) {
        b.addEventListener("click", function () { apply(b.dataset.theme); });
      });
      mark(current());
    })();
  </script>`;
}

// Branding (platform-admin only): rename the instance and give it an icon. Values are the
// currently effective brand (stored or default) so the form shows what is live. `saved`
// renders a confirmation flash after a successful POST.
export function brandingSection({ name, tagline, icon }, saved) {
  return `<a class="back" href="/">&larr; All apps</a>
  <h1>Branding</h1>
  <p class="desc">The name, tagline and icon shown in the top bar, browser tab and page titles across the portal. Applies to everyone.</p>
  ${saved ? flash("Branding saved.", "ok") : ""}
  <form method="post" action="/settings/branding" class="form">
    <label>Name <input name="name" required value="${esc(name)}"><small>the brand shown in the top bar and titles. Defaults to "${esc(BRAND_DEFAULTS.name)}".</small></label>
    <label>Tagline <input name="tagline" value="${esc(tagline)}"><small>the small grey suffix after the name. Leave blank for none.</small></label>
    <label>Icon <input name="icon" value="${esc(icon)}"><small>emoji or image URL, like an app card icon. Leave blank for the default wave mark. Also used as the browser tab favicon.</small></label>
    <button class="btn primary" type="submit">Save branding</button>
  </form>`;
}

// Billing & data: read-only freshness panel answering "is my data current?". Everything
// comes from the portal's own Postgres (no cloud API calls). `cost` is the freshest
// cost_snapshots row (captured_at + period), `usage` the freshest usage_snapshots row,
// `coverage` the count of apps with snapshots.
export function billingDataSection({ cost, usage, coverage }) {
  const costLine = cost
    ? `<dd>${timeEl(cost.captured_at)} <small>(${esc(ago(cost.captured_at))})</small></dd>`
    : `<dd class="nodata">no cost snapshot captured yet</dd>`;
  const periodLine = cost
    ? `<dd>${esc(cost.period_start)} to ${esc(cost.period_end)}</dd>`
    : `<dd class="nodata">-</dd>`;
  const usageLine = usage
    ? `<dd>${timeEl(usage.captured_at)} <small>(${esc(ago(usage.captured_at))})</small></dd>`
    : `<dd class="nodata">no usage snapshot captured yet</dd>`;
  const costApps = coverage ? coverage.cost_apps : 0;
  const usageApps = coverage ? coverage.usage_apps : 0;
  return `<a class="back" href="/">&larr; All apps</a>
  <h1>Billing &amp; data</h1>
  <p class="desc">Is the portal's cost and usage data current? These figures come from the portal's own database, written by the telemetry collector. No live cloud queries are made here.</p>
  <section class="panel">
    <h3>Freshness</h3>
    <dl class="meta">
      <dt>Latest cost snapshot</dt>${costLine}
      <dt>Period covered</dt>${periodLine}
      <dt>Latest usage snapshot</dt>${usageLine}
      <dt>Apps with cost data</dt><dd>${costApps}</dd>
      <dt>Apps with usage data</dt><dd>${usageApps}</dd>
      <dt>Collector schedule</dt><dd>${esc(COLLECTOR_SCHEDULE_HUMAN)}</dd>
    </dl>
  </section>
  <section class="panel">
    <h3>Where this comes from</h3>
    <p class="note">Billing export is configured in the GCP Billing console (Billing export &gt; BigQuery export, dataset <code>wl_telemetry</code>). It accumulates forward only: figures begin from the day the export was switched on, and there is no backfill for periods before that.</p>
  </section>`;
}

export function errorPage(status, message) {
  return `<div class="errbox"><h1>${esc(status)}</h1><p>${esc(message)}</p><a href="/">Home</a></div>`;
}
