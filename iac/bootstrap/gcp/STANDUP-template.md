# Stand up Wavelength on GCP (+ Outline wiki)

Ordered runbook for bringing Wavelength up on a GCP instance and deploying the Outline
wiki as the first app behind the shared IAP perimeter. Each step links the canonical
runbook; only the cross-cutting notes live here. For prerequisites and the IdP options,
read [QUICKSTART.md](../../../QUICKSTART.md) first.

## Open inputs to collect first

| Input | Where used |
|---|---|
| `PROJECT_ID` (your dedicated project) | every stack |
| `ORG_ID` (numeric, your org) | org-edge workforce pool |
| `TENANT_ID` (Entra example) or your `oidc_*` IdP inputs | gateway, org-edge, outline OIDC |
| Anthropic egress CIDRs | org-edge `anthropic_cidrs` (MCP allowlist) |
| DNS control for your app subdomain | A records for `outline` + `outline-mcp`, managed-cert validation |
| `STATE_BUCKET` (from bootstrap output) | every `tofu init` |

## Local auth for `tofu` (do this once)

Before any local `tofu` apply, set up **refreshable** Application Default Credentials:

```bash
gcloud auth application-default login
gcloud auth application-default set-quota-project <PROJECT_ID>
```

Do **not** use a static `GOOGLE_OAUTH_ACCESS_TOKEN` for applies - it can't refresh, so
the ~10-15 min Cloud SQL create outlives it and the apply 401s mid-operation (the
instance ends up created on GCP but missing from state, needing a manual import to
recover). ADC refreshes automatically.

## Org prerequisites (do these upfront - each one can block a live apply mid-run)

On an org-backed instance (which forks are), sort these before applying or you will hit
them one at a time:

- **`gcloud auth application-default login`** (+ `set-quota-project`), plus **`az login`**
  to the Entra tenant when using the Entra worked example. ADC is required (see above).
- **Self-grant `roles/iam.workforcePoolAdmin`** on the org - it is NOT in Org
  Administrator, and the org-edge stack needs it.
- **Billing: grant the day admin `roles/billing.user`** on the billing account (a
  super-admin who created the account has it; Org Admin alone does not), so you can link
  the new project.
- **Request a `SECURITY_POLICIES` quota increase** (IAM & Admin > Quotas) if you want
  Cloud Armor / the MCP IP-allowlist - fresh projects start at 0. Until then keep
  `enable_cloud_armor = false`.
- **Secure-by-default org policies bite:** `iam.disableServiceAccountKeyCreation` blocks
  GCS HMAC keys (Outline uses gcsfuse instead - already handled), and domain-restricted
  sharing blocks `allUsers` (see "Gateway on an org" below).

## Gateway on an org (decision before deploying gateway-gcp)

`gateway-gcp` binds `allUsers` as the Cloud Run invoker on BOTH oauth2-proxy (public)
and Bifrost (internal, so the in-VPC proxy call needs no ID token). Domain-restricted
sharing on an org **blocks both**, so the gateway will not apply as-is. Options:

- **Quick:** a scoped `iam.allowedPolicyMemberDomains` exception at the project level
  (needs `orgpolicy.policyAdmin`) to permit `allUsers`/`allAuthenticatedUsers`. Unblocks
  both bindings without code changes.
- **Clean (recommended long-term):** front the Bifrost UI with the shared `iap-lb`
  module (like Outline), set its Cloud Run to `INTERNAL_LOAD_BALANCER`, drop the public
  oauth2-proxy, and harden app->Bifrost to ID-token invoker auth. IAP becomes Ring 1.

Outline does not depend on the gateway, so this only matters if you deploy it.

## Phase 0 - platform

0. **Org baseline** - [ORG-SETUP.md](ORG-SETUP.md). Confirm Cloud Identity on your org;
   verify the org node, a day-to-day admin holding `organizationAdmin` +
   `projectCreator` + **`iam.workforcePoolAdmin`** + `orgpolicy.policyAdmin`, billing,
   and a `wavelength` folder.
1. **Project** - `./create-project.sh` (step -1). Capture `PROJECT_ID`.
2. **State + CI identity** - `PROJECT_ID=... ./bootstrap.sh` (step 0). Set the printed
   `GCP_*` GitHub repo variables. Capture `STATE_BUCKET`.
3. **Landing zone** - `../../gcp/` (`prefix=gcp-landing-zone`). VPC, Cloud SQL (now incl.
   the `outline` DB + `outline-database-url` secret), Artifact Registry, Secret Manager,
   app SA. Seed the operator Anthropic/Replicate key secrets.
4. **Gateway** - `../../../gateway-gcp/` (`prefix=gcp-gateway`). Two-phase
   (`oauth2_proxy_url`), then seed Bifrost providers/virtual keys.
   - **ORG GOTCHA:** domain-restricted sharing **blocks the `allUsers` invoker** the
     oauth2-proxy uses ([oauth2proxy.tf](../../../gateway-gcp/oauth2proxy.tf), see
     ORG-SETUP.md "secure-by-default"). On an org this fails. **Decide here:**
     (a) **preferred** - front the Bifrost UI with the shared LB+IAP (the same
     [../../modules/iap-lb](../../modules/iap-lb) module), set its Cloud Run to
     `INTERNAL_LOAD_BALANCER`, and retire the public oauth2-proxy on GCP; or
     (b) **stopgap** - a scoped `iam.allowedPolicyMemberDomains` exception for that one
     service. (a) aligns with "IAP for all apps"; not yet built - a follow-up.
5. **Org edge (shared perimeter)** - [../../gcp-org/](../../gcp-org/)
   (`prefix=gcp-org-edge`), **human-run** by the workforce-pool admin. Workforce WIF +
   IAP OAuth client + Cloud Armor policies. Two-phase for the IAP handleRedirect URI.
   **Do the SPIKE in that README first** (confirm IAP gates a workforce identity
   end-to-end; fallback is oauth2-proxy + `TRUSTED_IPS`).

## Phase 1 - Outline

6. **Mirror images + deploy** - [../../../outline-gcp/](../../../outline-gcp/)
   (`prefix=gcp-outline`). Mirror `outlinewiki/outline` + `redis:7-alpine` into AR,
   `tofu apply`, then create the two DNS A records to `lb_ip_address` and wait for the
   managed cert.

## Phase 2 - MCP + guide

7. Point an Anthropic "Outline Native" connector at `https://<mcp_hostname>` with an
   Outline API token. Publish a "How to use Outline" guide (save into Outline).

## Verify

Acceptance checklist: org visible, landing-zone + gateway apply clean, Outline DB
migrated, human path (IAP -> Outline OIDC, one login), perimeter blocks unauth, MCP path
works only from Anthropic IPs, uploads persist to GCS, Redis-backed collaboration works.
