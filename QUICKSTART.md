# Quickstart - stand up Wavelength on GCP

This is the front-door runbook. It lists what you need, how identity works, and the order
to apply the stacks. The detailed, gotcha-annotated runbook is
[iac/bootstrap/gcp/STANDUP-template.md](iac/bootstrap/gcp/STANDUP-template.md); the trust
model is [iac/IDENTITY.md](iac/IDENTITY.md).

> **Create a PRIVATE copy of this repo first** (see *Create your private copy* below).
> Your copy will hold your own org, project, billing and identity-provider identifiers. A
> public copy leaks your cloud estate. CI enforces this:
> [`.github/workflows/private-repo-guard.yml`](.github/workflows/private-repo-guard.yml)
> fails on a public repo. To check locally: `gh repo view --json isPrivate -q .isPrivate`
> must print `true`.

## Prerequisites

- A **GCP organization** with Cloud Identity, a billing account, and an admin who can hold
  `roles/iam.workforcePoolAdmin` and create projects. See
  [iac/bootstrap/gcp/ORG-SETUP.md](iac/bootstrap/gcp/ORG-SETUP.md).
- An **OIDC identity provider** for human sign-in (see "Identity" below).
- A **DNS subdomain** you can delegate to Cloud DNS (e.g. `labs.example.com`).
- Tooling: `gcloud`, `tofu` (OpenTofu >= 1.6), `gh`, `docker`, and `az` only if you use
  the Entra worked example.
- This repo, copied into a **private repo** (see *Create your private copy* below).

## Create your private copy

Do **not** use GitHub's Fork button: a fork of a public repo stays public, cannot be made
private, and trips the private-repo guard on every push. Instead create your own private
repo and mirror this template into it:

```bash
gh repo create your-org/wavelength --private
git clone --bare https://github.com/<upstream-owner>/wavelength.git
cd wavelength.git && git push --mirror https://github.com/your-org/wavelength.git
cd .. && rm -rf wavelength.git
git clone https://github.com/your-org/wavelength.git && cd wavelength
git remote add upstream https://github.com/<upstream-owner>/wavelength.git
# later, to track template updates: git fetch upstream && git merge upstream/main
```

Verify it is private (the guard's local check): `gh repo view --json isPrivate -q .isPrivate`
must print `true`. Leave the `WAVELENGTH_UPSTREAM_SLUG` repo variable unset - it only
exempts the canonical public template from the guard, not your private copy.

## Identity (bring your own OIDC IdP)

The perimeter is provider-agnostic: GCP Workforce Identity Federation accepts any
OIDC/SAML2 IdP, and the load balancer module is IdP-neutral. Two supported paths:

- **Entra / Microsoft 365 (worked example, the default).** Leave
  `create_entra_app_registration = true` and set `entra_tenant_id`. The stacks
  auto-create the Entra app registrations (you run `az login`).
- **Any other OIDC IdP (e.g. Auth0).** Set `create_entra_app_registration = false` and
  supply the `oidc_*` inputs instead:
  - `oidc_issuer_uri` (e.g. `https://YOUR_TENANT.eu.auth0.com/`)
  - `oidc_client_id`, `oidc_client_secret` (from an app you create in your IdP)
  - `oidc_attribute_mapping` (org-edge) / the `oidc_*_uri` + claim inputs (apps), if your
    IdP's claim names or endpoints differ from Entra's.

  Register the redirect URIs your IdP needs: the workforce sign-in callback
  (`https://auth.cloud.google/signin-callback/locations/global/workforcePools/<pool>/providers/<provider>`),
  each app's OIDC callback (e.g. Outline's `https://<host>/auth/oidc.callback`), and the
  IAP `handleRedirect` URI (two-phase, see the org-edge README).

These inputs live in a gitignored `instance.auto.tfvars` per stack; copy each
`instance.auto.tfvars.example` to start.

## Apply order

1. **Bootstrap** ([iac/bootstrap/gcp/](iac/bootstrap/gcp/)) - run once by a human.
   - `./create-project.sh` creates the dedicated project (capture `PROJECT_ID`).
   - `REPO=<your-org>/wavelength PROJECT_ID=... ./bootstrap.sh` creates the state bucket
     and the WIF CI identity (capture `STATE_BUCKET`; set the printed `GCP_*` repo
     variables). `REPO` is required and must match your private copy's `owner/name` slug
     exactly.
2. **Org edge** ([iac/gcp-org/](iac/gcp-org/)) - run once per org by the
   workforce-pool admin (not CI). Workforce Identity Federation + IAP OAuth client +
   Cloud Armor. Two-phase for the IAP `handleRedirect` URI. Do the SPIKE in its README.
3. **Landing zone** ([iac/gcp/](iac/gcp/)) - per project. Cloud Run, Cloud SQL, VPC,
   Secret Manager, Artifact Registry, and your delegated DNS zone (`dns_zone_name` /
   `dns_zone_fqdn`, both required). Delegate the subdomain: add the `labs_dns_nameservers`
   output as NS records at your apex.
4. **An app** - e.g. [outline-gcp/](outline-gcp/), the reference app pattern. Mirror its
   images into Artifact Registry, apply, then create the app's DNS A records and wait for
   the managed cert.

The model gateway ([gateway-gcp/](gateway-gcp/)) is optional and independent of Outline;
note the org `allUsers` gotcha in STANDUP-template.md before deploying it.

## Verify

Use the acceptance checklist at the end of
[STANDUP-template.md](iac/bootstrap/gcp/STANDUP-template.md): org visible, applies clean,
one-login human path (IAP -> app OIDC), perimeter blocks unauthenticated traffic, MCP path
reachable only from allowed IPs, uploads persist.
