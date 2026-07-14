// Layer 3: the single in-process cloud seam (docs/portal.md).
//
//   resolveIdentity(request) -> { email, sub }   # email normalized; fail closed
//
// On GCP this is IAP JWT verification exactly as skills/onboard-app/references/
// iap-identity.md specifies. Behind Workforce Identity Federation there is NO top-level
// email claim: the email is the segment of workforce_identity.iam_principal after
// /subject/. No email-shaped claim => 403, never anonymous. Azure/AWS get their own
// adapters later behind the same contract; the core never learns which is in play.

import { createRemoteJWKSet, jwtVerify } from "jose";
import { normalizeOwnerEmail } from "./db.js";

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
  return { email: normalizeOwnerEmail(email), sub: String(payload.sub || "") };
}
