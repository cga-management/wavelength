# Identity: take the user from the IAP JWT (no login code)

The shared load balancer runs **IAP** in front of your Cloud Run service. Every request
that reaches your app has already been authenticated against the org SSO. Your app's job
(identity A) is: **verify the IAP JWT and read the user out of it** - IAP replaces your
login, session store, and password handling entirely.

## What IAP actually sends (verified on this platform, 2026-07-03)

Every request carries a signed JWT in one header:

```
X-Goog-IAP-JWT-Assertion: <compact JWT, ES256-signed by Google>
```

Decoded, the payload contains exactly these claims - a real (sanitized) example:

```json
{
  "aud": "/projects/123456789012/global/backendServices/987654321098765432",
  "azp": "/projects/123456789012/global/backendServices/987654321098765432",
  "exp": 1751560000,
  "iat": 1751559400,
  "iss": "https://cloud.google.com/iap",
  "identity_source": "WORKFORCE_IDENTITY_FEDERATION",
  "sub": "sts.google.com:AbCd1234ExampleOpaqueSubject...",
  "workforce_identity": {
    "iam_principal": "principal://iam.googleapis.com/locations/global/workforcePools/<workforce-pool>/subject/dev@example.com",
    "workforce_pool_name": "locations/global/workforcePools/<workforce-pool>"
  }
}
```

**The user's email is the segment of `workforce_identity.iam_principal` after
`/subject/`** (URL-decode it, then **normalize** it - see "Normalize the owner email"
below). In the example: `dev@example.com`.

> **Platform dependency:** that suffix is an email ONLY because the org edge maps
> `google.subject` to an email-shaped claim (`assertion.preferred_username` for Entra -
> the default in `iac/gcp-org`). If your `/subject/` value looks like an opaque id
> rather than an email, the workforce provider's attribute mapping is wrong - fix it
> there (see the "subject must be an email" section in the gcp-org README); no app-side
> code can recover an email that was never mapped in.

That resolved email is the platform's identity key: **key row ownership, RLS, and all
authz on it.** It is the same value `platform_admins` rows and the app's owner are keyed
by. (`sub` is an opaque `sts.google.com:` token - keep it for logging if you like, and key
nothing on it.)

For portability across IdP mappings, resolve the email by scanning in this order and
taking the first string containing `@`:

1. `email`, `preferred_username`, `upn` (top-level - absent on this platform, present on
   some other IdP setups)
2. the `/subject/` suffix of `workforce_identity.iam_principal` (what works here)

If nothing email-shaped is found, return 403 and log the claim KEY NAMES (never values) so
the shape stays observable in Cloud Run logs.

## Normalize the owner email (canonical)

The resolved email is the platform's identity key, so it MUST be reduced to one canonical
form - and normalized the SAME way everywhere an email becomes an `owner_id`: here at
resolution, when seeding `platform_admins`, and when stamping imported data (see
`data-migration.md`). If the stored `owner_id` and the value resolved at sign-in differ by
so much as a capital letter or a stray space, RLS silently shows the user nothing.

The rule: **strip control/zero-width characters, Unicode-NFKC normalize, trim, then
lowercase** (lowercase last).

```python
import unicodedata

def normalize_owner_email(raw: str) -> str:
    # THE single owner-email normalization for the whole platform. Reuse it verbatim
    # wherever an email becomes an owner_id, so stored and resolved values always match.
    e = "".join(c for c in raw if unicodedata.category(c)[0] != "C")  # drop control/format/zero-width
    e = unicodedata.normalize("NFKC", e).strip()                      # canonical form, trim edges
    return e.lower()                        # 'Dev.User@Example.com ' -> 'dev.user@example.com'
```

## What to verify before trusting the payload

- **Signature:** ES256 against Google's IAP JWKS at
  `https://www.gstatic.com/iap/verify/public_key-jwk`.
- **`iss`** equals `https://cloud.google.com/iap`.
- **`aud`** equals your backend's audience - the value of your stack's
  `computed_iap_audience` output (the LB module builds it from the numeric backend id).
  The deploy workflow injects it as the `IAP_AUDIENCE` env var between its two apply
  phases; read it from the environment. Working example of the value:
  `/projects/123456789012/global/backendServices/987654321098765432`.
- **`exp`/`iat`** are current.

## Fail closed

- A missing or unverifiable header means something is wrong (IAP guarantees it in normal
  operation): reject with 401/403, never fall back to "anonymous" or "allow".
- Trust only `X-Goog-IAP-JWT-Assertion` (cryptographically signed). The
  `X-Goog-Authenticated-User-*` headers are unverified convenience copies - fine for
  debugging, not a security boundary.

## FastAPI snippet (identity A)

Dependencies - add ALL THREE to your requirements; each missing one fails differently
and none of the failures name the missing package at request time:

- `google-auth` - the verifier (`id_token.verify_token`).
- `pyjwt` - google-auth needs it to parse the IAP certs endpoint's **JWK** key format;
  without it every verify raises `ImportError: The pyjwt library is not installed ...`,
  which the except-branch turns into a blanket 403 for every signed-in user (the app
  builds, boots and probes green - it fails only when a real user arrives).
- `cryptography` - ES256 signature support.

```python
# app/iap.py
import hashlib
import hmac
import json
import os
from datetime import date
from urllib.parse import unquote
from fastapi import Request, HTTPException, Depends
from google.auth.transport import requests as ga_requests
from google.oauth2 import id_token

_IAP_AUDIENCE = os.environ["IAP_AUDIENCE"]  # = the stack's computed_iap_audience output
_request = ga_requests.Request()

# Usage-telemetry auth line (see "The usage-telemetry auth line" below). Mode + salt are
# platform config injected by the app stack. Hashed mode without a salt falls back to
# email mode with ONE startup warning: telemetry fails open, auth never blocks on it.
_USAGE_IDENTITY_MODE = os.environ.get("USAGE_IDENTITY_MODE", "email")
_USAGE_HASH_SALT = os.environ.get("USAGE_HASH_SALT", "")
if _USAGE_IDENTITY_MODE == "hashed" and not _USAGE_HASH_SALT:
    print(json.dumps({"severity": "WARNING", "message":
                      "USAGE_IDENTITY_MODE=hashed but USAGE_HASH_SALT is empty - falling back to email mode"}))
    _USAGE_IDENTITY_MODE = "email"
_usage_seen: dict[str, set[str]] = {}  # date string -> tokens already emitted that day


def _usage_token(email: str) -> str:
    if _USAGE_IDENTITY_MODE == "hashed":
        return hmac.new(_USAGE_HASH_SALT.encode(), email.encode(), hashlib.sha256).hexdigest()[:32]
    return email


def _emit_auth_line(email: str) -> None:
    # At most one line per user per day per instance (scale-to-zero resets are harmless,
    # the collector's DISTINCT dedupes across instances and restarts).
    today = date.today().isoformat()
    if today not in _usage_seen:
        _usage_seen.clear()  # the date rolled - drop yesterday's set
        _usage_seen[today] = set()
    token = _usage_token(email)
    if token not in _usage_seen[today]:
        _usage_seen[today].add(token)
        print(json.dumps({"severity": "INFO", "message": "authenticated",
                          "event": "wl.auth", "user": token}))

class CurrentUser:
    def __init__(self, email: str, opaque_id: str):
        self.id = email          # resolved email, normalized - THE owner / identity key
        self.email = email
        self.opaque_id = opaque_id   # the JWT sub (sts.google.com:...), for logging only

def current_user(request: Request) -> CurrentUser:
    assertion = request.headers.get("X-Goog-IAP-JWT-Assertion")
    if not assertion:
        raise HTTPException(status_code=401, detail="missing IAP assertion")
    try:
        claims = id_token.verify_token(
            assertion, _request, audience=_IAP_AUDIENCE,
            certs_url="https://www.gstatic.com/iap/verify/public_key-jwk",
        )
    except Exception as exc:
        # Log the error class + message ONLY - never the assertion (logging.md). The
        # message names the failing check (wrong audience, expired, certs fetch,
        # missing pyjwt) and distinguishes "bad token" from "we can never verify".
        print(json.dumps({"severity": "WARNING", "message": "IAP assertion verification failed",
                          "error": type(exc).__name__, "errorDetail": str(exc)[:200]}))
        raise HTTPException(status_code=403, detail="invalid IAP assertion")
    if claims.get("iss") != "https://cloud.google.com/iap":
        raise HTTPException(status_code=403, detail="bad issuer")
    email = _resolve_email(claims)
    if not email:
        wi = claims.get("workforce_identity") or {}
        print("no email-shaped claim; keys:", sorted(claims), "wi:", sorted(wi))
        raise HTTPException(status_code=403, detail="no email claim")
    email = normalize_owner_email(email)  # see "Normalize the owner email"
    _emit_auth_line(email)  # usage-telemetry auth line, at most once per user per day
    return CurrentUser(email=email, opaque_id=claims.get("sub", ""))

def _subject_suffix(s):
    # principal://iam.googleapis.com/locations/global/workforcePools/<pool>/subject/<email>
    if not isinstance(s, str) or "/subject/" not in s:
        return None
    return unquote(s.rsplit("/subject/", 1)[1])

def _resolve_email(claims) -> str | None:
    wi = claims.get("workforce_identity") or {}
    candidates = [
        claims.get("email"), claims.get("preferred_username"), claims.get("upn"),
        _subject_suffix(wi.get("iam_principal")), _subject_suffix(claims.get("sub")),
    ]
    return next((c for c in candidates if isinstance(c, str) and "@" in c), None)

# usage in a route:
#   @app.get("/items")
#   def list_items(user: CurrentUser = Depends(current_user)): ...
```

## The usage-telemetry auth line

Workforce-federated IAP emits no per-request audit entries, so the platform's
unique-user counts (docs/usage-telemetry.md) come from the apps themselves: after each
successful verification the identity layer emits **one structured line per user per
day**:

```json
{"severity": "INFO", "message": "authenticated", "event": "wl.auth", "user": "<token>"}
```

The landing-zone log sink routes ONLY these lines (matched on `event="wl.auth"`) to the
telemetry dataset, where 90-day partition expiration bounds their life; the portal's
collector aggregates them per Cloud Run service. What `user` carries is the platform's
`usage_identity_mode` (a landing-zone variable, injected as `USAGE_IDENTITY_MODE`):

- **email** (default): the normalized email. The portal can then show WHO uses your app
  (a 30d user list) - visible only to your app's admins and platform admins. Everyone
  with log or dataset access can already see these emails via stronger paths, so this
  buys visibility without weakening anything.
- **hashed**: `HMAC-SHA256(platform salt, normalized email)`, hex, first 32 chars. The
  salt arrives as `USAGE_HASH_SALT` (Secret Manager, platform-wide). Counts only - the
  portal shows no user list anywhere. This is the stricter posture, and it is ONE
  landing-zone variable flip plus app redeploys away.

Telemetry must never break sign-in: unknown mode or a missing salt means fall back to
email mode (warn once at startup), and the emit itself sits after verification succeeds.
This line is also the ONE sanctioned exception to "never log user identifiers to shared
logs" - see rule 5 in `logging.md`.

## Framework-agnostic recipe

1. Read `X-Goog-IAP-JWT-Assertion`; 401 if absent.
2. Verify ES256 signature against the IAP JWKS; check `iss`, `aud` (= `IAP_AUDIENCE` env),
   `exp`. On verification failure, log the error CLASS and message (never the token),
   then reject 403 - the message names the failing check, which is the difference
   between "attacker sent garbage" and "this app can never verify anything".
3. Resolve the email per the scan above; **normalize it** with `normalize_owner_email`
   (see "Normalize the owner email"). That normalized email is the owner id. No
   email-shaped value: 403, log claim key names only.
4. Emit the usage-telemetry auth line (see the section above): token = the normalized
   email, or its keyed hash when `USAGE_IDENTITY_MODE=hashed` (salt from
   `USAGE_HASH_SALT`); dedupe in-process per user per day; fall back to email mode if
   the salt is missing. Never let this step fail the request.
5. Make the identity available to every request handler (middleware / request context).
6. Pass the email down to the DB layer for RLS - see `shared-db-rls.md`. Admin is
   entitlement plus an opt-in MODE (see that file); a request runs with admin powers only
   while the user has the mode switched on.

## Session expiry in a browser SPA (graceful re-auth)

IAP enforces at the load balancer **edge**, so an expired session is dealt with before the
request reaches your app. On a top-level navigation IAP 302-redirects the browser through
sign-in (silent if the IdP SSO session is still alive) - fine. But a background
`fetch`/XHR **cannot** follow that cross-origin login redirect: it fails CORS / returns an
opaque response or an HTML login page, and code that expects JSON throws. Classic symptom:
leave a tab idle, come back, click something, the action errors, and only a full page
refresh fixes it.

Handle it in the client so an expired session becomes a clean reload, not an error. Route
API calls through one choke point; on an auth-shaped failure (opaque/redirected response,
a network error, or a non-JSON body where JSON was expected) reload the page - a top-level
navigation lets IAP re-authenticate, usually with no password prompt.

```js
// app/lib/api.js - single choke point for all API calls
export async function api(path, init) {
  let res
  try {
    // Don't auto-follow IAP's cross-origin login 302 - detect it instead.
    res = await fetch(path, {
      ...init,
      redirect: 'manual',
      headers: { ...(init?.headers), Accept: 'application/json' },
    })
  } catch {
    return reauth() // network/CORS error - session almost certainly gone
  }
  const ct = res.headers.get('content-type') || ''
  if (res.type === 'opaqueredirect' || res.status === 401 || !ct.includes('application/json')) {
    return reauth() // IAP bounced us to sign-in
  }
  return res
}

function reauth() {
  window.location.reload() // top-level nav -> IAP re-auths (silent if SSO session alive)
  return new Promise(() => {}) // never resolves; the reload takes over
}
```

Nicer UX (optional): instead of an immediate reload, show a "Session expired - click to
continue" toast that reloads on click, so an in-progress action is never lost to a raw
error; a low-frequency heartbeat to a tiny endpoint can surface expiry proactively.

Session **length** is a separate, platform-side lever (the workforce pool's
`sessionDuration`; GCP's own default is 1h, the org-edge stack defaults it to 8h); this
section is only about handling expiry gracefully whatever the length.

## Local development

Locally there is no IAP header. Gate the "trust a dev header / fixed dev user" fallback
behind an explicit `APP_ENV=local` (or similar) flag that is **never** set in the deployed
service, so the deployed app only ever trusts the verified IAP JWT.
