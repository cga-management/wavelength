// Dependency-free 5-field cron (UTC only) for deploy schedules. Deliberately small:
// numeric fields with "*", lists ",", ranges "-" and steps "/" - no month/day names, no
// seconds field, no timezones. The portal has five dependencies and prizes that; a full
// cron library (and its date dependency) buys nothing this surface needs.
//
// Semantics follow standard cron: when BOTH day-of-month and day-of-week are restricted
// (neither is "*"), a date matches if EITHER matches (OR), otherwise the restricted one
// must match.

const FIELDS = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of week", min: 0, max: 7 }, // 0 and 7 are both Sunday
];

function parseField(part, { name, min, max }) {
  const values = new Set();
  for (const item of part.split(",")) {
    // step: "*/n", "a-b/n"
    const [rangePart, stepPart] = item.split("/");
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step < 1) throw new Error(`invalid step in ${name}: "${item}"`);
    let lo;
    let hi;
    if (rangePart === "*" || rangePart === "") {
      lo = min;
      hi = max;
    } else if (rangePart.includes("-")) {
      const [a, b] = rangePart.split("-").map(Number);
      lo = a;
      hi = b;
    } else {
      lo = Number(rangePart);
      hi = stepPart === undefined ? lo : max; // "5/15" means "5-max/15", per cron
    }
    if (!Number.isInteger(lo) || !Number.isInteger(hi) || lo < min || hi > max || lo > hi) {
      throw new Error(`invalid ${name} value: "${item}" (allowed ${min}-${max})`);
    }
    for (let v = lo; v <= hi; v += step) values.add(v);
  }
  if (values.size === 0) throw new Error(`empty ${name} field`);
  return values;
}

// Parse a 5-field cron string. Returns the per-field value sets plus restriction flags
// for the standard dom/dow OR rule. Throws with a human-readable message on bad input.
export function parseCron(str) {
  const parts = String(str || "").trim().split(/\s+/);
  if (parts.length !== 5) {
    throw new Error('cron needs 5 fields: minute hour day month weekday (e.g. "0 2 * * 1")');
  }
  const [minute, hour, dom, month, dow] = parts.map((p, i) => parseField(p, FIELDS[i]));
  if (dow.has(7)) dow.add(0); // 7 = Sunday alias
  return {
    minute,
    hour,
    dom,
    month,
    dow,
    domRestricted: parts[2] !== "*",
    dowRestricted: parts[4] !== "*",
  };
}

function matches(c, d) {
  if (!c.minute.has(d.getUTCMinutes())) return false;
  if (!c.hour.has(d.getUTCHours())) return false;
  if (!c.month.has(d.getUTCMonth() + 1)) return false;
  const domOk = c.dom.has(d.getUTCDate());
  const dowOk = c.dow.has(d.getUTCDay());
  if (c.domRestricted && c.dowRestricted) return domOk || dowOk;
  if (c.domRestricted) return domOk;
  if (c.dowRestricted) return dowOk;
  return true;
}

// Next fire strictly after `from`, in UTC. Minute-stepping keeps the matcher and the
// stepper trivially consistent (correctness over cleverness); worst case is ~527k cheap
// iterations, and anything with no match inside 366 days can never fire.
export function nextFire(str, from = new Date()) {
  const c = typeof str === "object" ? str : parseCron(str);
  const d = new Date(from.getTime());
  d.setUTCSeconds(0, 0);
  d.setUTCMinutes(d.getUTCMinutes() + 1);
  const limit = 366 * 24 * 60;
  for (let i = 0; i < limit; i++) {
    if (matches(c, d)) return new Date(d.getTime());
    d.setUTCMinutes(d.getUTCMinutes() + 1);
  }
  throw new Error("cron never fires within a year");
}

// Milliseconds between the next two fires - the creation-time guardrail against
// schedules that would dispatch a deploy on every scheduler tick ("* * * * *").
export function minIntervalMs(str, from = new Date()) {
  const first = nextFire(str, from);
  const second = nextFire(str, first);
  return second.getTime() - first.getTime();
}

const DAY_NAMES = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function hhmm(h, m) {
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
}

// A short human reading for the common shapes, ALWAYS derived from the stored cron
// string (never a hand-maintained constant - see COLLECTOR_SCHEDULE_HUMAN in views.js
// for the dual-source-of-truth mistake this avoids). Anything unusual falls back to
// the raw string, which is honest.
export function describeCron(str) {
  let c;
  try {
    c = parseCron(str);
  } catch {
    return String(str || "");
  }
  const single = (set) => (set.size === 1 ? [...set][0] : null);
  const m = single(c.minute);
  const h = single(c.hour);
  const allMonths = c.month.size === 12;
  if (m === null || !allMonths) return String(str).trim();

  if (h !== null && !c.domRestricted && !c.dowRestricted) {
    return `daily at ${hhmm(h, m)} UTC`;
  }
  if (h !== null && c.dowRestricted && !c.domRestricted && c.dow.size <= 3) {
    const days = [...c.dow].filter((d) => d !== 7).sort().map((d) => DAY_NAMES[d]);
    return `${days.join(", ")} at ${hhmm(h, m)} UTC`;
  }
  if (h !== null && c.domRestricted && !c.dowRestricted && c.dom.size === 1) {
    return `day ${[...c.dom][0]} of each month at ${hhmm(h, m)} UTC`;
  }
  return String(str).trim();
}
