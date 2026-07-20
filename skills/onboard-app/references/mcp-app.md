# Exposing an MCP server (machine access from the Anthropic connector)

This is the edge layer of identity C, the machine path the base skill defers as "out of
scope" (SKILL.md guardrails, `archetypes.md`; the app-layer companion is
`connector-oauth.md`). Use it when the app must be reached by a **non-browser client** -
specifically an Anthropic MCP connector - rather than (or in addition to) humans in a
browser. It is how the platform exposes MCP hosts (Outline's MCP endpoint is the live
example).

Everything in the base skill still applies: internal-ingress Cloud Run, scale-to-zero,
a slice of the shared Postgres, API keys in Secret Manager, private-first, the same
`deploy-app` workflow. This doc only adds the **auth/edge layer** for the machine path.

The canonical, annotated implementation is `outline-gcp/lb.tf` (edge routing) and
`iac/gcp-org/armor.tf` (the Cloud Armor policy). Read those alongside this.

## The core idea: IAP does not gate machines

A human host sits behind IAP (org SSO). A machine client cannot complete an interactive
SSO sign-in, so the MCP path must **bypass IAP** and be protected another way:

- **`enable_iap = false`** on the MCP route.
- **Cloud Armor `anthropic-only`** attached instead: default-deny, allowing only Anthropic's
  egress CIDRs. This is the external-IP restriction (same one that protects the Outline MCP
  connector).
- **The MCP server's own OAuth** authenticates the individual user. Claude cannot send static
  bearer tokens, so the connector does an OAuth flow (dynamic client registration + token
  exchange) against the MCP server. That is what identifies "which authenticated user".

So access control on the MCP path = **source IP (Cloud Armor) + connector OAuth**, not IAP.

## The shared Cloud Armor policy (do not make your own)

The Anthropic allowlist is a **shared, org-level** policy, created once in
`iac/gcp-org/armor.tf` as `‹workload›-armor-anthropic-only` (default-deny, one allow rule).
Your app does not define it - it attaches it via the LB module's `security_policy` field,
reading the id from org-edge remote state: `local.edge.armor_anthropic_only_id`.

The Anthropic CIDR list is maintained centrally in `iac/gcp-org/instance.auto.tfvars`
(`anthropic_cidrs`, currently `160.79.104.0/21`) and is an **operator** concern. Use
Anthropic's **outbound** range, since for MCP Anthropic connects TO us: per
https://platform.claude.com/docs/en/api/ip-addresses the outbound IPv4 range is
`160.79.104.0/21` (no IPv6 outbound published). Do NOT use the narrower **inbound** range
`160.79.104.0/23` - that is where Anthropic receives connections, and it would block part of
the outbound range. The `/21` is a superset of the `/23`. Check that doc for changes before a
new MCP app goes live. The allow rule is dynamic on a non-empty list, so an empty list yields
pure default-deny (fail-closed).
Cloud Armor is behind `enable_cloud_armor` because fresh projects ship with a
`SECURITY_POLICIES` quota of 0 - confirm it is enabled before relying on the IP lock.

## Two topologies - pick one

### Topology 1: dedicated MCP hostname (MCP-only app, e.g. a CRM connector)

If there is no human UI (or the UI is irrelevant), give the app a single MCP hostname on the
IAP-off, Anthropic-locked backend. In your `lb.tf`, replace the single IAP route in
`app-stack/lb.tf` with:

```hcl
routes = [
  {
    hostname        = var.mcp_hostname          # e.g. crm-mcp.‹subdomain›
    enable_iap      = false
    security_policy = try(local.edge.armor_anthropic_only_id, null)
  },
]
```

The connector points at `https://‹mcp_hostname›/mcp`. The server serves its own OAuth
discovery/register/token endpoints on that host.

### Topology 2: one host, path-split (a human UI AND an MCP path on it, Outline-style)

When the same app serves a browser UI (IAP-gated) and an MCP path (machine), keep the UI on
an IAP route and **path-route the machine endpoints** to a second IAP-off backend on the same
LB/IP/cert. The vendored `iap-lb` module supports this directly via `path_overrides`
(`modules/iap-lb/variables.tf`); `outline-gcp/lb.tf` carries the two-hostname route pair
this extends (this instance's Outline points its connector at the MCP hostname directly,
so it does not need the overrides):

```hcl
routes = [
  {
    hostname        = var.app_hostname          # humans
    enable_iap      = true
    security_policy = try(local.edge.armor_sso_default_id, null)
    path_overrides = [{
      target_hostname = var.mcp_hostname         # machine backend, IAP-off
      paths = [
        "/.well-known/oauth-authorization-server",
        "/.well-known/oauth-protected-resource",
        "/.well-known/oauth-protected-resource/*",
        "/oauth/token",
        "/oauth/register",
        "/oauth/revoke",
        "/mcp",
        "/mcp/*",
      ]
    }]
  },
  {
    hostname        = var.mcp_hostname
    enable_iap      = false
    security_policy = try(local.edge.armor_anthropic_only_id, null)
  },
]
```

Note `/oauth/authorize` is deliberately NOT in the override list: it is the browser consent
step and stays IAP-gated so the human still authenticates via the workforce pool. Use this
topology when the app (like Outline) builds its OAuth/MCP metadata from a single UI URL and
would otherwise send the connector to the IAP-gated host.

## Operator gotcha: the non-IAP backend needs an invoker

A non-IAP route has no IAP service agent invoking Cloud Run, so the module does not grant the
run-invoker for it. The MCP backend needs either `allUsers` as `roles/run.invoker` on the
service OR a scoped org-policy exception (domain-restricted-sharing blocks the public
invoker by default). The Cloud Run service still stays internal-ingress (LB only) - "allUsers
invoker" means "the LB may invoke it", not "publicly reachable". Flag this to the operator;
it is the one edge grant the app stack cannot fully self-serve. See the module comment in
`iac/modules/iap-lb/main.tf`.

## Upstream OAuth (the app talking OUT to a third party, e.g. a CRM)

Do not conflate the two OAuth flows:

- **Connector -> MCP server** (above): authenticates the Claude user to your server.
- **MCP server -> upstream API** (e.g. a CRM): your server acting as an OAuth client of the
  third party. This is ordinary app-side work:
  - Store the upstream **client id/secret** as a dedicated Secret Manager secret in your app
    stack, injected into Cloud Run via `value_source.secret_key_ref` (never plaintext env).
    Mirror the pattern in `outline-gcp/oidc.tf` (`outline-oidc-client-secret`).
  - Store **per-user access/refresh tokens** in your app's DB slice (the shared-Postgres
    database this app self-provisions), keyed by the connector-authenticated user, with the
    same per-user RLS discipline as `shared-db-rls.md`.

## Definition of done (in addition to the base checklist)

- A request to the MCP hostname **from a non-Anthropic IP returns 403** (Cloud Armor
  default-deny). Confirm `enable_cloud_armor = true` and `anthropic_cidrs` is current.
- The connector completes OAuth: register/token/`.well-known` reach the IAP-off backend; on
  Topology 2, `/oauth/authorize` still challenges via IAP.
- The Cloud Run service is still internal-ingress; the only invoker on the MCP backend is the
  LB (`allUsers` invoker or org-policy exception), not public ingress.
- Upstream (third-party) client secret is in Secret Manager, not the repo; per-user upstream
  tokens live in the app's DB slice under RLS.
