// Layer 3: the single in-process cloud seam (docs/portal.md).
//
//   resolveIdentity(request) -> { email, sub }   # email normalized; fail closed
//
// On GCP this is IAP JWT verification exactly as skills/onboard-app/references/
// iap-identity.md specifies. Behind Workforce Identity Federation there is NO top-level
// email claim: the email is the segment of workforce_identity.iam_principal after
// /subject/. No email-shaped claim => 403, never anonymous. Azure/AWS get their own
// adapters later behind the same contract; the core never learns which is in play.

import { createHmac } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import { normalizeOwnerEmail } from "./db.js";
import { log } from "./logger.js";

const IAP_JWKS_URL = "https://www.gstatic.com/iap/verify/public_key-jwk";
const IAP_ISSUER = "https://cloud.google.com/iap";

// IAP audience = this backend's computed_iap_audience output, injected by the two-phase
// apply as IAP_AUDIENCE. Empty until phase 2 - the app then fails closed on every request
// (it cannot verify the aud), which is the intended behaviour between the two applies.
const IAP_AUDIENCE = process.env.IAP_AUDIENCE || "";

// APP_ENV=local turns on a dev-header fallback so the portal is runnable off-platform.
// It is NEVER set on the deployed service, so the deployed app only trusts the IAP JWT.
const APP_ENV = process.env.APP_ENV || "platform";

const jwks = createRemoteJWKSet(new URL(IAP_JWKS_URL));

// Usage-telemetry auth line (iap-identity.md, "The usage-telemetry auth line"): one
// structured wl.auth line per user per day, carrying the platform's chosen identity
// token. Mode + salt are landing-zone config; hashed mode without a salt falls back to
// email mode with ONE startup warning - telemetry fails open, auth never blocks on it.
let USAGE_IDENTITY_MODE = process.env.USAGE_IDENTITY_MODE || "email";
const USAGE_HASH_SALT = process.env.USAGE_HASH_SALT || "";
if (USAGE_IDENTITY_MODE === "hashed" && !USAGE_HASH_SALT) {
  log.warning("USAGE_IDENTITY_MODE=hashed but USAGE_HASH_SALT is empty - falling back to email mode");
  USAGE_IDENTITY_MODE = "email";
}

const usageSeen = new Map(); // date string -> Set of tokens already emitted that day

function usageToken(email) {
  if (USAGE_IDENTITY_MODE === "hashed") {
    return createHmac("sha256", USAGE_HASH_SALT).update(email).digest("hex").slice(0, 32);
  }
  return email;
}

// At most one line per user per day per instance (scale-to-zero resets are harmless,
// the collector's DISTINCT dedupes across instances and restarts).
function emitAuthLine(email) {
  const today = new Date().toISOString().slice(0, 10);
  if (!usageSeen.has(today)) {
    usageSeen.clear(); // the date rolled - drop yesterday's set
    usageSeen.set(today, new Set());
  }
  const token = usageToken(email);
  const seen = usageSeen.get(today);
  if (seen.has(token)) return;
  seen.add(token);
  log.info("authenticated", { event: "wl.auth", user: token });
}

export class IdentityError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function subjectSuffix(s) {
  // principal://iam.googleapis.com/locations/global/workforcePools/<pool>/subject/<email>
  if (typeof s !== "string" || !s.includes("/subject/")) return null;
  try {
    return decodeURIComponent(s.split("/subject/").slice(-1)[0]);
  } catch {
    return s.split("/subject/").slice(-1)[0];
  }
}

function resolveEmail(claims) {
  const wi = claims.workforce_identity || {};
  const candidates = [
    claims.email,
    claims.preferred_username,
    claims.upn,
    subjectSuffix(wi.iam_principal),
    subjectSuffix(claims.sub),
  ];
  return candidates.find((c) => typeof c === "string" && c.includes("@")) || null;
}

// Resolve the caller's identity from the request. Throws IdentityError (fail closed) when
// the assertion is missing, unverifiable, or carries no email-shaped claim.
export async function resolveIdentity(req) {
  if (APP_ENV === "local") {
    const dev = req.headers["x-dev-user"] || process.env.DEV_USER;
    if (dev) return { email: normalizeOwnerEmail(dev), sub: "local:" + dev };
    throw new IdentityError(401, "local: set X-Dev-User header or DEV_USER");
  }

  const assertion = req.headers["x-goog-iap-jwt-assertion"];
  if (!assertion) throw new IdentityError(401, "missing IAP assertion");
  if (!IAP_AUDIENCE) throw new IdentityError(403, "IAP audience not configured (phase 2 pending)");

  let payload;
  try {
    ({ payload } = await jwtVerify(assertion, jwks, {
      issuer: IAP_ISSUER,
      audience: IAP_AUDIENCE,
      algorithms: ["ES256"],
    }));
  } catch {
    throw new IdentityError(403, "invalid IAP assertion");
  }

  const email = resolveEmail(payload);
  if (!email) {
    // Log claim KEY NAMES only (never values) so the shape stays observable.
    const wi = payload.workforce_identity || {};
    throw new IdentityError(403, `no email claim; keys=${Object.keys(payload).sort().join(",")} wi=${Object.keys(wi).sort().join(",")}`);
  }
  const normalized = normalizeOwnerEmail(email);
  emitAuthLine(normalized); // usage-telemetry auth line, at most once per user per day
  return { email: normalized, sub: String(payload.sub || "") };
}
