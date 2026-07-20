# Connector OAuth (identity C): the app as its own OAuth 2.1 authorization server

This is the app-layer companion to `mcp-app.md`. That doc owns the **edge**: the
path-split LB topologies, the shared Cloud Armor `anthropic-only` policy, CIDR
management, and the invoker gotcha. This doc owns the **app**: the code an
MCP/agent-facing app runs to authenticate connectors itself, with human identity
anchored at the one IAP-gated endpoint. In the platform taxonomy
(`docs/app-archetypes.md`) this is **identity C** - the machine-path sibling of
identity A, with the IAP JWT as the only identity root in both. It is the identity
layer of the "connector service" and "dual-audience app" archetypes.

The reference implementation is the bullhorn-mcp app repo (live-validated
2026-07-14/15): `src/bullhorn_mcp/oauth_http.py` (HTTP glue + middleware),
`src/bullhorn_mcp/oauth_server.py` (token logic), `src/bullhorn_mcp/identity.py`
(IAP JWT verification), and the four `oauth_*` tables in `src/bullhorn_mcp/db.py`.
These are app-agnostic by design: lift them nearly verbatim (see "Lifting the
implementation" below).

## The problem in two sentences

An MCP connector is a machine client: it cannot complete IAP's interactive
browser SSO, so the whole server cannot sit behind IAP - but static API keys are
unacceptable, and every request must still resolve to a named person for
authorization and write attribution. The resolution: IAP authenticates the human
exactly once, at the OAuth consent step (the one moment in the handshake where a
real browser is present), and the app's own OAuth 2.1 authorization server
converts that IAP-verified moment into rotating, owner-bound bearer tokens the
machine uses on every subsequent call.

The result: no login code in the app, no static credentials in the connector,
and every `/mcp` request still resolves to a named user.

## The five endpoints

| Endpoint | Purpose | Backend |
|---|---|---|
| `GET /.well-known/oauth-protected-resource` (+ `/mcp` suffix variant) | RFC 9728: declares `/mcp` protected and names the AS | machine (IAP off) |
| `GET /.well-known/oauth-authorization-server` | RFC 8414 AS metadata: endpoints, `authorization_code` + `refresh_token` grants, PKCE S256 | machine (IAP off) |
| `POST /oauth/register` | RFC 7591 dynamic client registration: mints a public (secret-less) `client_id` per connector, returns 201 | machine (IAP off) |
| `GET /oauth/authorize` | Browser consent step: the ONLY endpoint where human identity enters | human (IAP on) |
| `POST /oauth/token` | Code and refresh-token exchange | machine (IAP off) |

Two rules that are easy to get wrong:

- The Claude connector probes `/.well-known/oauth-protected-resource/mcp` (the
  path-suffix variant) BEFORE the base path. Serve the same metadata document on
  both, or discovery fails.
- `/oauth/authorize` must stay on the IAP-gated backend; everything else the
  connector calls machine-to-machine. The LB path-split that achieves this is
  `mcp-app.md` topology 2 - never add `/oauth/authorize` to the path-override
  list.

## The token model

| Artifact | TTL | Semantics |
|---|---|---|
| Authorization code | 5 min | Single use (consumed via `DELETE ... RETURNING`), owner-bound, PKCE challenge stored with it |
| Access token | 1 hour | Opaque bearer, owner-bound, records its issuing refresh token |
| Refresh token | 60 days | OAuth 2.1 rotation: each use mints a new access+refresh pair in the same `family_id` and marks the presented token rotated |

Rotation and theft detection, exactly as `oauth_server.py` implements it:

- A refresh token is single-use. Replaying an already-rotated token is tolerated
  ONLY within a 60 s grace window (`ROTATION_GRACE`) and only if its recorded
  successor is still active - that case is a client retry after a dropped
  response, and the server hands back the successor refresh token plus a fresh
  access token. Any other replay is treated as theft and **revokes the entire
  family** (all access and refresh tokens in the grant).
- PKCE: S256 and plain, constant-time compare (`pkce_verify`).
- No client secrets anywhere in the flow: connectors are public PKCE clients
  (`token_endpoint_auth_methods_supported: ["none"]`).
- Refresh is silent: `POST /oauth/token` with `grant_type=refresh_token` on the
  machine backend - no browser, no IAP hop. The user sees a browser again only
  when the refresh family is revoked or expires.

## Identity anchoring: verify the IAP JWT at /oauth/authorize ONLY

`/oauth/authorize` is the only place a verified human identity exists, so it is
the only place to read one. Per `identity.py`:

1. Read `X-Goog-IAP-JWT-Assertion` from the request. Missing header = fail.
2. Verify the JWT: ES256 against Google's IAP JWKS
   (`https://www.gstatic.com/iap/verify/public_key`), `iss` must be
   `https://cloud.google.com/iap`, `aud` must equal `IAP_AUDIENCE` (from env;
   see the two-phase-apply pointer below). Verification fails closed if the
   audience is empty.
3. Resolve an email-shaped claim, in order: top-level `email`,
   `preferred_username`, `upn`, then the `/subject/` suffix of
   `workforce_identity.iam_principal` (workforce-pool identities carry the email
   there, not in `email` - see `iap-identity.md`).
4. Normalize the email with the platform's single normalization (strip control
   and zero-width chars, NFKC, trim, lowercase LAST - `normalize_owner_email` in
   `db.py`, copied verbatim from `iap-identity.md`).
5. Bind the normalized email as `owner_id` on the single-use auth code. It flows
   from there onto every access and refresh token and every attribution lookup.

**Fail closed**: any failure at any step is a 403 with no fallback identity. Do
not trust `X-Goog-Authenticated-User-Email` here and do not invent a default
owner. Never verify the IAP JWT on `/mcp` or the other machine endpoints - there
is no IAP on that backend, so any assertion header arriving there is
attacker-controlled input.

## The 401 challenge is the flow trigger, not politeness

Unauthenticated `POST /mcp` (no `Authorization: Bearer`, or an invalid/expired
token) MUST return:

```
HTTP/1.1 401 Unauthorized
WWW-Authenticate: Bearer resource_metadata="https://<host>/.well-known/oauth-protected-resource"
```

This header is what makes the connector start (or restart) the OAuth flow.
Without it the connector assumes it is connected and never authenticates -
bullhorn-mcp's server initially answered unauthenticated `/mcp` with 200 and the
connector silently never ran the flow (live-log evidence, 2026-07-14). The
challenge plus the metadata served on both `.well-known` paths is the complete
discovery contract.

## Persistence: the four oauth_* tables and owner binding

All flow state lives in the app's shared-Postgres slice, created by idempotent
boot migrations (`SCHEMA` in `db.py`):

| Table | Holds | Key columns |
|---|---|---|
| `oauth_clients` | DCR registrations | `client_id`, `redirect_uris`, `client_name` |
| `oauth_authorization_codes` | Pending consents | `code`, `client_id`, `redirect_uri`, `owner_id`, `code_challenge`, `code_challenge_method`, `scope`, `expires_at` |
| `oauth_access_tokens` | Live bearers | `token`, `client_id`, `owner_id`, `refresh_token` (issuer link for family revocation), `expires_at` |
| `oauth_refresh_tokens` | Rotation state | `refresh_token`, `client_id`, `owner_id`, `scope`, `family_id`, `successor_token`, `rotated_at`, `expires_at` |

These tables are server-internal (looked up by token or code, never by user
session), so they do not carry the per-user RLS discipline of
`shared-db-rls.md`; any per-user upstream tokens you add alongside them do.

**Owner-binding middleware** (`owner_binding_middleware` in `oauth_http.py`): on
every `/mcp` request, resolve the bearer token to its `owner_id` and stash it in
a request-scoped context (a `contextvars.ContextVar` in the reference
implementation) that tool handlers read for authorization decisions and
attribution. Non-`/mcp` routes explicitly clear the context so no owner leaks
across requests. Missing or invalid token short-circuits to the 401 challenge
above.

## Upstream credentials never enter the connector flow

Whatever third party the server calls (its "upstream"), those credentials are
app-side: a dedicated Secret Manager secret injected via
`value_source.secret_key_ref`, exactly as `mcp-app.md` describes for upstream
OAuth. They must never appear in the connector flow, and connector tokens must
never be sent upstream. The two layers meet at exactly one point: the flow's
`owner_id` is used for authorization decisions and attribution, nothing else.

Bullhorn's version of that join: on writes, the owner email is mapped to a
Bullhorn `CorporateUser` id (exact match then Lucene lookup, must be unique,
cached - `src/bullhorn_mcp/attribution.py`) and passed as
`commentingPerson`/owner. Best effort: if no unique match, the write lands as
the shared API account with a loud warning, rather than failing the operation.

## Logging note: pin HTTP-client loggers

If the upstream flow places credentials in URL query strings (Bullhorn's
headless auth-code grant puts the password there), request-URL logging at INFO
will leak them into Cloud Logging. Pin the HTTP client's loggers (for httpx:
`httpx` and `httpcore`) to WARNING at startup, and never log those URLs
yourself. See `_configure_logging` in bullhorn-mcp's `src/bullhorn_mcp/server.py`
and the note in `logging.md`.

## Lifting the implementation

`oauth_http.py`, `oauth_server.py`, `identity.py`, and the four `oauth_*` table
definitions in `db.py` contain no Bullhorn-specific logic. They are designed to
be copied nearly verbatim into the next connector service: wire the routes into
your HTTP framework, supply `public_base_url`, `IAP_AUDIENCE`, and a database
URL, and keep the constants (`CODE_TTL`, `TOKEN_TTL`, `REFRESH_TOKEN_TTL`,
`ROTATION_GRACE`) as they are unless you have a concrete reason.

Copy-paste, not a shared library: two consumers do not justify the versioning
and release overhead of a shared package, and the code is small enough to audit
in one sitting. Revisit extraction when the third consumer appears.

## Edge layer: one-line pointers

Everything below is owned by `mcp-app.md` - read it alongside this doc:

- LB topologies (dedicated MCP hostname vs one-host path-split), the shared
  Cloud Armor `anthropic-only` policy, and CIDR management.
- The machine backend needs the `run.invoker` org-policy exception (no IAP
  service agent on a non-IAP backend) - flag to the operator.
- `IAP_AUDIENCE` reaches the app via env from the two-phase deploy apply; JWT
  verification fails closed while it is empty.

## Definition of done (app layer, in addition to mcp-app.md's checklist)

- Unauthenticated `POST /mcp` returns **401 with the `WWW-Authenticate: Bearer
  resource_metadata=...` challenge** (not 200, not a bare 401).
- `GET /.well-known/oauth-protected-resource` and
  `.../oauth-protected-resource/mcp` return the same metadata; the AS metadata
  advertises `authorization_code` + `refresh_token` grants, S256, and
  `token_endpoint_auth_methods_supported: ["none"]`.
- `/oauth/authorize` challenges via IAP (an unauthenticated browser is redirected
  to org SSO); with a valid session it 302s back with a code; a missing or
  invalid IAP assertion returns **403 with no fallback identity**.
- A stored auth code expires at 5 min and cannot be exchanged twice; the second
  exchange returns `invalid_grant`.
- A refresh token rotates on use; replaying the OLD token outside the 60 s grace
  window (or after its successor has itself rotated) **revokes the whole family**,
  and the connector is forced back through the browser flow.
- Every issued token row carries a normalized `owner_id`, and tool handlers see
  that owner in the request context on every `/mcp` call.
- The upstream secret exists only in Secret Manager and the upstream client
  module; it is absent from the connector-flow code paths (`oauth_http.py` /
  `oauth_server.py` equivalents import nothing from the upstream client).
- HTTP-client loggers are pinned to WARNING if any upstream flow carries
  credentials in URLs; grep the logs after a token refresh to confirm no URL
  with credentials was logged.
