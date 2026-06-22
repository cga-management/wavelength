# Platform IaC (OpenTofu)

One IaC tool - **OpenTofu** - across every target cloud. Azure is built and proven first; GCP and AWS follow the same layout.

## Structure

- `bootstrap/` - **step 0**, run once by a human before anything else. Creates the remote state backend and the GitHub OIDC identity that lets CI run `tofu` without stored cloud secrets. Cannot itself be run by CI (chicken-and-egg), so it uses local state and is applied from a workstation.
- `modules/` - cloud-agnostic building blocks shared across clouds.
- `azure/`, `gcp/`, `aws/` - per-cloud landing zones. Each consumes `modules/` and supplies cloud-specific resources.

## Conventions

- Everything is a variable: org, tenant/project/account, subscription, region, naming prefix. No hardcoded identifiers.
- Remote state per cloud, created in `bootstrap/`.
- CI authenticates via OIDC federation (no long-lived cloud credentials in GitHub).

**Status:** scaffold. The Azure landing zone is the first thing to flesh out and validate (`tofu validate`, `tofu plan`). See `azure/` and the repo `HANDOFF.md`.
