# Org edge - shared human-SSO perimeter (GCP)

The shared perimeter every wavelength app on GCP sits behind:

- **Workforce Identity Federation** with your **OIDC IdP** - so IAP can authenticate your
  workforce users (who have no Google identities). GCP Workforce Identity Federation
  accepts any OIDC/SAML2 IdP; **Entra / M365 ships as the worked example** (this stack can
  auto-create the Entra app registration). For another IdP (e.g. Auth0) set
  `create_entra_app_registration = false` and supply the `oidc_*` inputs.
- The **IAP OAuth client** (a GCP OAuth client, distinct from the IdP app) used by both
  the workforce provider and IAP.
- Shared **Cloud Armor** policies: `sso-default` (IAP-gated human hosts, rate-limited)
  and `anthropic-only` (MCP hosts, default-deny + Anthropic IP allowlist).

App stacks read this stack's outputs (state prefix `gcp-org-edge`) and attach their LB
backends via [../modules/iap-lb/](../modules/iap-lb/). This is the build-out
[../bootstrap/gcp/ORG-SETUP.md](../bootstrap/gcp/ORG-SETUP.md) flagged as the one
remaining edge step.

## Who runs this

A **human day-to-day admin**, not CI. The workforce pool is an **org-level** resource
needing `roles/iam.workforcePoolAdmin`, which the project-scoped CI service account
deliberately does not hold. Authenticate with `gcloud auth application-default login`
(GCP), plus `az login` when using the Entra worked example (the azuread provider).

## SPIKE - validate before relying on this

The workforce + IAP wiring is built to documented structure but must be confirmed
against your live IdP:

1. **`web_sso_config`** (`response_type`, `assertion_claims_behavior`) against current
   Google docs for an OIDC workforce provider.
2. **IdP app redirect URIs**. The workforce sign-in callback
   (`https://auth.cloud.google/signin-callback/locations/global/workforcePools/<pool>/providers/<provider>`)
   is set automatically. The **IAP handleRedirect URI** embeds the generated client id,
   so it is two-phase (below).
3. Confirm IAP gating with a **workforce** identity end-to-end (sign in, reach the app).
   If unviable, fall back to the repo's `oauth2-proxy` pattern with
   `OAUTH2_PROXY_TRUSTED_IPS` for the Anthropic bypass.
4. **Confirm the resolved subject is the user's email**, not an opaque id (see "The
   subject must be an email" below): sign in to any app and check that the workforce
   principal in its logs/IAP JWT ends in `/subject/<email>`.

## The subject must be an email (or email-keyed apps fail closed)

Apps behind IAP resolve the user's identity from the `/subject/` suffix of
`workforce_identity.iam_principal` in the IAP JWT and key ALL authorization on that
email ([iap-identity.md](../../skills/onboard-app/references/iap-identity.md)). That
suffix is whatever `google.subject` maps to - so the mapping MUST be an email-shaped
claim. For Entra that is `preferred_username` (the UPN), which is this stack's default.

If `google.subject` maps the opaque `assertion.sub`, every email-keyed app (the portal,
any onboard-app tenant) rejects every user with 403 - IAP passes, the app fails closed.
Outline does not catch this (it runs its own OIDC), so the first symptom is often the
first non-Outline app.

**Changing the mapping on a live pool poisons existing sessions**: the
`auth.cloud.google` workforce session carries the subject minted at sign-in, so users
keep presenting the old value until they re-federate. A fresh incognito window (or
clearing cookies for `auth.cloud.google` and the app host) forces a clean sign-in.

## Deploy (two-phase, like the gateway)

```bash
tofu init \
  -backend-config="bucket=wl-tfstate-<token>" \
  -backend-config="prefix=gcp-org-edge"

# Phase 1: create the pool/provider/app/policies (IAP redirect still a placeholder).
tofu apply \
  -var project_id=<PROJECT_ID> \
  -var organization_id=<ORG_ID> \
  -var entra_tenant_id=<TENANT_ID>        # Entra example; omit for another IdP + set oidc_*

# Read the client id, build the IAP handleRedirect URI, re-apply.
CID=$(tofu output -raw oidc_app_client_id)
tofu apply \
  -var project_id=<PROJECT_ID> \
  -var organization_id=<ORG_ID> \
  -var entra_tenant_id=<TENANT_ID> \
  -var iap_oauth_redirect_uri="https://iap.googleapis.com/v1/oauth/clientIds/${CID}:handleRedirect"
```

Supply `anthropic_cidrs` (list) once Anthropic's egress ranges are known; until then
`anthropic-only` is pure default-deny (safe).

## Outputs (consumed by app stacks)

| Output | Use |
|---|---|
| `workforce_pool_name` | IAP settings + the `iap.httpsResourceAccessor` principalSet |
| `oidc_app_client_id` | IdP client id; build the handleRedirect URI (null when bringing your own IdP) |
| `iap_client_secret_id` | Secret Manager id for the IAP oauth2 client secret |
| `armor_sso_default_id` | Cloud Armor policy for human (IAP) hosts |
| `armor_anthropic_only_id` | Cloud Armor policy for MCP hosts |
