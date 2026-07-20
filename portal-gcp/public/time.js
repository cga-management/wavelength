// Progressive enhancement for the platform time convention (docs/portal.md, "Time and
// timezones"): UTC at rest, local at the glass, explicit zone at every boundary. Three
// jobs, all dependency-free, all idempotent, all silent no-ops without JS (which is why
// every server-rendered fallback spells out UTC):
//
// 1. Rewrite every <time datetime="<ISO-8601-UTC>"> to the viewer's local time with a
//    short zone suffix ("17 Jul 2026, 10:45 BST"), keeping the UTC string on title.
// 2. Fill [data-tz-name] elements with the browser's resolved IANA zone, so forms can
//    say "Times shown in Europe/London".
// 3. Convert datetime-local pickers marked data-utc-field: the picked local wall-clock
//    becomes a UTC ISO-8601 instant in the named hidden field before submit, with a
//    live echo line ("fires at 09:00 UTC, 10:00 your time") in [data-utc-echo].
(function () {
  "use strict";

  function pad2(n) {
    return String(n).padStart(2, "0");
  }

  function localizeTimes() {
    var fmt;
    try {
      fmt = new Intl.DateTimeFormat(undefined, {
        day: "2-digit",
        month: "short",
        year: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
        timeZoneName: "short",
      });
    } catch (e) {
      return; // no Intl support: the UTC fallback text stands
    }
    document.querySelectorAll("time[datetime]").forEach(function (el) {
      if (el.dataset.tzLocalized === "1") return;
      var d = new Date(el.getAttribute("datetime"));
      if (isNaN(d.getTime())) return;
      if (!el.title) el.title = el.textContent.trim();
      el.textContent = fmt.format(d);
      el.dataset.tzLocalized = "1";
    });
  }

  function fillZoneNames() {
    var zone;
    try {
      zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } catch (e) {
      return;
    }
    if (!zone) return;
    document.querySelectorAll("[data-tz-name]").forEach(function (el) {
      el.textContent = zone;
    });
  }

  // A datetime-local input carrying data-utc-field="run_at" feeds the hidden form field
  // named run_at with the picked instant as UTC ISO-8601 (Z-suffixed). The server accepts
  // ONLY that shape, so a JS-off submit fails loudly instead of firing an hour off.
  function wirePickers() {
    document.querySelectorAll('input[type="datetime-local"][data-utc-field]').forEach(function (input) {
      var form = input.form;
      if (!form) return;
      var hidden = form.elements[input.dataset.utcField];
      var echo = form.querySelector("[data-utc-echo]");
      function sync() {
        var d = input.value ? new Date(input.value) : null; // zoneless string parses as LOCAL time
        if (!d || isNaN(d.getTime())) {
          if (hidden) hidden.value = "";
          if (echo) echo.hidden = true;
          return;
        }
        if (hidden) hidden.value = d.toISOString();
        if (echo) {
          echo.textContent = "fires at " + d.toISOString().slice(0, 10) + " "
            + pad2(d.getUTCHours()) + ":" + pad2(d.getUTCMinutes()) + " UTC, "
            + pad2(d.getHours()) + ":" + pad2(d.getMinutes()) + " your time";
          echo.hidden = false;
        }
      }
      input.addEventListener("input", sync);
      input.addEventListener("change", sync);
      form.addEventListener("submit", sync);
      sync();
    });
  }

  function run() {
    localizeTimes();
    fillZoneNames();
    wirePickers();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", run);
  } else {
    run();
  }
})();
