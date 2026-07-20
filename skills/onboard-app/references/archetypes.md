# Archetypes: which of the five is this app?

An archetype is a named combination of build mode, audience, identity, and state that this
skill turns into a concrete recipe. Decide it before wiring anything. The platform canon
behind these names (the axes, invariants, and contracts) is `docs/app-archetypes.md` in
the platform repo; this file is the skill-side map.

## The five archetypes

1. **Custom user app** (default) - source-built from your Dockerfile, human users in a
   browser, identity A, a slice of the shared Postgres. The typical internal tool / CRUD
   app; the main SKILL.md step order IS this recipe.
2. **Packaged user app** - prebuilt upstream image you do not modify (WordPress), human
   users, identity B (the app keeps its own login behind IAP). Outline is its
   platform-managed cousin.
3. **Connector service** - called by an Anthropic MCP connector, not a browser; identity C
   (connector OAuth). Source-built (bullhorn-mcp is the live example) or prebuilt.
4. **Internal service** - called only by sibling apps behind the perimeter (agent memory,
   retrieval engines - the Hindsight/Aspected class); service identity, usually +pgvector.
   Still gets a hostname: the route is Cloud Armor-locked, no IAP.
5. **Dual-audience app** - one app, a human route AND a connector route, path-split at the
   load balancer (`mcp-app.md`, topology 2). Live example: Outline plus its MCP endpoint.

## Quick decision

- **Prebuilt or source?** An upstream image you should not rebuild -> packaged user app
  (or internal service). Your own Dockerfile -> custom user app or connector service.
- **Who calls it?** Humans in a browser -> custom or packaged user app. An Anthropic
  connector -> connector service. Only sibling platform apps -> internal service. Humans
  AND a connector -> dual-audience app.
- **Does it keep its own login?** Yes -> identity B (packaged user app). No -> identity A
  (custom user app).

## The identity axis

Every archetype fixes an identity value: how a request proves who it is. All three values
share one root - the IAP JWT minted at the shared perimeter is the only identity source.

### A - inherit the IAP identity (default for custom apps)

The app has no meaningful login of its own (or only a throwaway local one). IAP
authenticates the user; the app reads the verified username from the IAP JWT and never
implements auth.

- **Use for:** internal tools, CRUD apps, dashboards, most bespoke apps.
- **Do:** strip/skip the app's login; add the IAP-JWT middleware (`iap-identity.md`); key
  data ownership + RLS off the IAP user (`shared-db-rls.md`).
- **Result:** one sign-in (the IAP/SSO one). Simplest and preferred for custom apps.

### B - the app keeps its own auth, behind IAP

The app has a real, built-in login you should not rip out (WordPress, Outline, off-the-shelf
apps). IAP is an outer gate that blocks unauthenticated traffic; the app still runs its own
login inside.

- **Use for:** packaged/third-party apps, or apps whose auth/roles are load-bearing.
- **Do:** keep the app's login. Still do scale-to-zero, the shared DB (`shared-db-rls.md`),
  Secret Manager keys (`secrets.md`), private-first, and the deploy. Do NOT wire the IAP JWT
  into the app's auth.
- **Trade-off:** the user signs in twice (IAP, then the app) unless the app can federate to
  the same IdP - if it can (e.g. via OIDC), point it at the org IdP so the second sign-in is
  silent. That is the app's own OIDC setup, separate from this skill.
- **Note:** if the app also needs a non-browser/machine entry point (an API or MCP endpoint
  a service calls without a browser), that path cannot use IAP the same way - it is the
  connector route of a dual-audience app, protected by identity C below. See `mcp-app.md`
  for the edge pattern (it is how the platform exposes MCP hosts, e.g. Outline's connector).

### C - connector OAuth (the machine path)

The caller is an Anthropic MCP connector, which cannot complete an interactive SSO sign-in.
The app runs its own OAuth 2.1 authorization server for the connector - but the human
behind it still proves who they are exactly once, at the IAP-gated `/oauth/authorize`
consent step. C is A's machine-path sibling: in both, the IAP JWT is the only identity
root; C anchors it at the consent step and mints connector tokens from there.

- **Use for:** connector services, and the connector route of a dual-audience app.
- **Do:** the edge layer per `mcp-app.md` (IAP off on the machine path, Cloud Armor
  anthropic-only); the app layer per `connector-oauth.md` (the OAuth endpoints, token
  model, owner binding). bullhorn-mcp is the reference implementation.
- **Result:** every connector token maps back to an IAP-verified user, so ownership and
  RLS keep working on the machine path.
