# Wavelength

Wavelength is an **open-source runbook for standing up your own AI platform on your own
cloud**. You create a private copy of this repo, supply your own cloud and identity provider, and run the
infrastructure-as-code to deploy a private, SSO-gated platform: a model gateway, a wiki,
and the shared kit apps build on. It is a runbook you operate yourself, not a managed
service anyone runs for you.

> **Create a PRIVATE copy of this repo** (not a GitHub fork - see QUICKSTART). Your copy
> will hold your own org, project, billing and identity-provider identifiers. A public
> copy leaks your cloud estate. The conformance workflow fails on a public repo for
> exactly this reason - see [QUICKSTART.md](QUICKSTART.md).

## Status

- **GCP** is the supported v1 target. Start with [QUICKSTART.md](QUICKSTART.md).
- **Azure / AWS** are experimental and not part of v1 (see [ROADMAP.md](ROADMAP.md)).
- **Identity** is provider-agnostic: GCP Workforce Identity Federation accepts any
  OIDC/SAML2 IdP. Microsoft Entra / 365 ships as the worked example; another OIDC IdP
  (e.g. Auth0) is a supported configuration - see [QUICKSTART.md](QUICKSTART.md).

## Layout

| Path | What it is |
|------|------------|
| `iac/bootstrap/` | Step -1/0 per cloud: create the project + state backend + CI OIDC identity, run once by a human |
| `iac/gcp-org/` | Shared org-edge perimeter (Workforce Identity Federation + IAP + Cloud Armor), run **once per org by an admin** |
| `iac/gcp/` | Per-project landing zone (Cloud Run, Cloud SQL, VPC, Secret Manager, Artifact Registry, DNS), run **per project by CI** |
| `iac/modules/` | Cloud-agnostic building blocks (e.g. the reusable IAP load balancer) |
| `iac/IDENTITY.md` | The trust model: which privileges the operator needs and which stay with your identity admin |
| `gateway/bifrost/` | Shared Bifrost model-gateway image source (Dockerfile + config), built into your registry |
| `gateway-gcp/` | Model gateway (Bifrost) behind an OIDC-gated proxy on Cloud Run |
| `outline-gcp/` | Outline wiki - the first app on the shared perimeter, and the reference app pattern |
| `portal-gcp/` | The admin portal - the platform control plane (registry, gated deploys, cost/usage showback, runtime logs) per `docs/portal.md` |
| `skills/` | Claude Code skills: **onboard-app** (take a local app to deployed-behind-IAP, agent-driven), build standard, PII assessment, conformance |
| `docs/` | Design docs: the admin portal control plane, per-app cost showback, per-app usage telemetry |
| `TEARDOWN.md` | Destroy runbook: order, the async producer-release gotchas, bootstrap cleanup |
| `scanner/`, `archive/` | Data-estate scanner and inactivity-archive jobs (placeholders) |

## Principles

- **Nothing hardcodes your org, project, tenant, domain or region.** They are required
  variables, so the kit stamps cleanly into your own cloud. Per-instance config (tfvars,
  backend, CI variables) and state live with your instance, never in this repo.
- **One IaC tool (OpenTofu)** across all clouds - no per-cloud dialects.
- **Least privilege:** the platform runs as a project-scoped CI identity with no standing
  human privilege; org/identity admin actions are a separate, revocable role.
- **The conformance gate is one definition called centrally,** not duplicated per app.

## Getting started

Read [QUICKSTART.md](QUICKSTART.md): prerequisites (a GCP org, an OIDC IdP, a billing
account), then the apply order (`bootstrap` -> `gcp-org` -> `gcp` -> an app). The work is
done in Claude Code from your private copy, where the cloud CLIs and your credentials live.

## License

Licensed under the Apache License, Version 2.0. See [LICENSE](LICENSE).
