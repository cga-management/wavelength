# Archetypes: inherit IAP, or keep your own auth behind IAP

Decide which the app is before wiring identity. Both sit behind the shared IAP perimeter;
they differ only in whether the app runs its own login.

## A - Custom app inherits IAP identity (default)

The app has no meaningful login of its own (or only a throwaway local one). IAP
authenticates the user; the app reads the verified username from the IAP JWT and never
implements auth.

- **Use for:** internal tools, CRUD apps, dashboards, most bespoke apps.
- **Do:** strip/skip the app's login; add the IAP-JWT middleware (`iap-identity.md`); key
  data ownership + RLS off the IAP user (`shared-db-rls.md`).
- **Result:** one sign-in (the IAP/SSO one). Simplest and preferred for custom apps.

## B - App keeps its own auth, behind IAP

The app has a real, built-in login you should not rip out (WordPress, Outline, off-the-shelf
apps). IAP is an outer gate that blocks unauthenticated traffic; the app still runs its own
login inside.

- **Use for:** third-party/packaged apps, or apps whose auth/roles are load-bearing.
- **Do:** keep the app's login. Still do scale-to-zero, the shared DB (`shared-db-rls.md`),
  Secret Manager keys (`secrets.md`), private-first, and the deploy. Do NOT wire the IAP JWT
  into the app's auth.
- **Trade-off:** the user signs in twice (IAP, then the app) unless the app can federate to
  the same IdP - if it can (e.g. via OIDC), point it at the org IdP so the second sign-in is
  silent. That is the app's own OIDC setup, separate from this skill.
- **Note:** if the app also needs a non-browser/machine entry point (e.g. an API or MCP
  endpoint that a service calls without a browser), that path cannot use IAP the same way -
  it needs an IAP-bypass + IP-allowlist on a separate hostname. See `references/mcp-app.md`
  for the full pattern (it is how the platform exposes MCP hosts, e.g. Outline's connector).

## Quick decision

- Does the app already have a login you must keep? -> **B**.
- Otherwise -> **A** (inherit IAP; write no auth).
