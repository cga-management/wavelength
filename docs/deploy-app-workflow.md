# The deploy-app workflow: platform pull-and-deploy for onboarded apps

Operator runbook for [`.github/workflows/deploy-app.yml`](../.github/workflows/deploy-app.yml),
the workflow proposed in
[RFC #17](https://github.com/cga-management/wavelength/issues/17) and adopted as-is.
The app-side view of the same flow is
[deploy.md](../skills/onboard-app/references/deploy.md) in the onboard-app skill.

The model: the onboarding user never touches the cloud project. They push their app
(root `Dockerfile` + an `iac/` stack from the onboard-app skill, `iap-lb` vendored in)
to a private repo in the org; an operator dispatches this workflow from the platform
repo, which pulls that repo and deploys it under the platform's federated CI identity.
Because the workflow runs in THIS repo, its OIDC token is one the bootstrap WIF provider
already trusts - no WIF or security change is needed to enable app deploys, and no human
keys or app-side `gcloud` exist anywhere.

## One-time setup

Repo **variables** on the platform repo (bootstrap.sh prints the first four at the end
of its run):

| Variable | Value |
|---|---|
| `GCP_PROJECT_ID` | the platform project id |
| `GCP_PROJECT_NUMBER` | its numeric project number |
| `GCP_WIF_PROVIDER` | full WIF provider resource name |
| `GCP_SERVICE_ACCOUNT` | the CI service account email |
| `GCP_STATE_BUCKET` | the tofu state bucket (bootstrap prints it as the backend `bucket` value, e.g. `wl-tfstate-<token>`) |
| `GCP_REGION` | optional, default `europe-west2` |
| `GCP_WORKLOAD` | optional, default `wl` |
| `GCP_ENVIRONMENT` | optional, default `platform` |

Repo **secret**: `APP_REPO_TOKEN`, a fine-grained PAT or GitHub App token with
`contents:read` on the org's app repos. This exists because the workflow-provided
`GITHUB_TOKEN` is scoped to the repository the workflow runs in; it cannot read a
different private repo, so checking out the app repo needs a real cross-repo credential.
`contents:read` is all it needs - it never writes to app repos.

## Dispatch inputs

| Input | Meaning |
|---|---|
| `app_repo` | app repo to deploy, e.g. `<your-org>/myapp` |
| `ref` | branch, tag, or sha to deploy (default `main`) |
| `app_slug` | the app slug: db name, image name, and state-prefix suffix (`gcp-<slug>`) |
| `app_hostname` | public hostname, e.g. `myapp.labs.example.com` |
| `app_owner_email` | the deploying dev's email (app owner / admin) |
| `image_tag` | optional; blank means the commit sha, which is what makes a redeploy roll a new Cloud Run revision |

## Per-app prerequisites (before first deploy of that app)

- The app repo is private in the org and contains a root `Dockerfile` plus the `iac/`
  stack with `iap-lb` vendored in (onboard-app skill output).
- Any API-key secrets seeded in Secret Manager, values supplied out of band.
- No database carve-out: the app stack self-provisions its database, its own DB user,
  and the `<slug>-database-url` secret on the first apply (see the skill's
  `app-stack/database.tf`; one-time hardening SQL in
  [db-hardening.md](../skills/onboard-app/references/db-hardening.md)).

## The hardening, and the failure each piece prevents

Each item below was added after its absence cost a real debugging session:

- **Ref-exists preflight with a default-branch hint.** Before checkout, the workflow
  resolves `commits/<ref>` in the app repo via the API. If the ref is missing it fails
  immediately with the repo's actual default branch in the error and a concrete
  rename-to-main recipe - instead of the checkout action's cryptic git retry loop. A
  `master` vs `main` mismatch was the first thing a real third-party onboarding hit.
- **Onboarded-repo preflight.** An app can be registered for deploy before it has been
  through the onboard-app skill at all. The workflow checks for the root `Dockerfile`
  and the vendored `iac/modules/iap-lb/main.tf`, and the error names the exact
  onboarding step to finish - instead of an opaque failure later at `docker build` or
  `tofu init`.
- **Env-indirected inputs.** Dispatch inputs are routed through `env:` rather than
  interpolated into `run:` bodies with `${{ }}`, so a crafted input value is data,
  never shell. This matters as soon as deploys are dispatched from a UI whose fields
  are user-typed (the portal of [portal.md](portal.md)).
- **Per-slug queued concurrency.** `concurrency.group: deploy-app-<slug>` with
  `cancel-in-progress: false`: one deploy per app at a time, queued not cancelled. A
  second dispatch for the same slug would otherwise race the tofu state between the
  two apply phases; cancelling mid-deploy would strand a half-applied stack.
- **`run-name` embeds the app** (`deploy <slug> (<repo>@<ref>)`), so the Actions list
  is not N identical "deploy-app" rows, and a portal can locate the run it dispatched.

Two build decisions worth knowing: the image is built with plain docker on the runner
and pushed to Artifact Registry (no Cloud Build dependency, only AR write on the CI
identity), and it is tagged by the checked-out commit sha unless `image_tag` is given -
a changing tag is what makes the IaC see a new image ref and roll a new revision; a
static tag leaves updated code un-deployed.

## The two-phase IAP-audience apply

The IAP JWT audience contains the LB backend service's numeric id, which does not exist
until the stack has been applied once. So the workflow applies twice:

1. **Phase 1**: full apply with `iap_audience=""`. Everything is created; the app fails
   closed (it rejects tokens it cannot verify) until phase 2.
2. **Phase 2**: the backend now exists, so the stack's `computed_iap_audience` output is
   real. The workflow reads it with `tofu output -raw computed_iap_audience` and
   re-applies with it, after which the app verifies IAP tokens against the correct
   audience.

Both phases run inside one job under the per-slug concurrency group, so nothing can
interleave between them.

## After the run

The job summary prints the hostname and LB IP. The stack creates the DNS record; the
Google-managed certificate then provisions once the hostname resolves (roughly 15-60
minutes on a first deploy). Redeploys of an already-certified host are live as soon as
the new revision is ready.
