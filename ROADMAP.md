# Roadmap

Wavelength v1 is the **GCP** path with a provider-agnostic OIDC perimeter (Entra shipped
as the worked example). Known follow-ups, roughly in priority order:

## Identity

- **Validated Auth0 (and other OIDC) examples.** The `oidc_*` inputs already make any OIDC
  IdP a supported configuration (`create_entra_app_registration = false`). A fully
  worked, end-to-end-validated Auth0 example (issuer, claim mapping, redirect URIs) is
  pending - contributions welcome.

## GCP hardening

- **Gateway on an org.** Replace the gateway's public `oauth2-proxy` + `allUsers` invoker
  with the shared IAP load balancer (Bifrost UI behind IAP, Cloud Run set to
  `INTERNAL_LOAD_BALANCER`, app->Bifrost on ID-token invoker auth). Makes IAP the single
  Ring-1 pattern for every app. See STANDUP-template.md "Gateway on an org".
- **Cloud Armor / MCP IP allowlist.** Fresh projects ship `SECURITY_POLICIES` quota = 0;
  request an increase, then set `enable_cloud_armor = true` and supply `anthropic_cidrs`
  to lock the MCP host to Anthropic egress ranges.

## Other clouds (experimental)

- **Azure.** Second-class for now (Container Apps + EasyAuth/oauth2-proxy). Kept in the
  private development repo and promoted to public as PRs once validated. Not part of v1.
- **AWS.** Bootstrap and landing-zone are spec stubs only; built after Azure.

## Platform

- **Estate-reconciliation conformance job.** Diff the declared PII assessment against a
  scan of the hosted data estate at the Stage 1 -> 2 boundary and on later deploys.
- **Secret scanning.** Wire gitleaks (or equivalent) into the conformance gate (currently
  a placeholder).
