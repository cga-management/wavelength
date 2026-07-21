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
| `context_dir` | optional; directory inside the app repo holding the `Dockerfile` and `iac/` (default `.`, the repo root) |

### Subdirectory apps (`context_dir`)

By default the workflow expects the app repo's deployable unit at its root: a root
`Dockerfile` and an `iac/` stack. `context_dir` relaxes that for apps that live in a
subdirectory of a larger repo: the onboarded-repo preflight, the docker build context,
and the tofu stack directory (`<context_dir>/iac`, addressed with `tofu -chdir`) are all
scoped to that directory. The motivating case is the portal self-deploying per
[portal.md](portal.md): its reference implementation is a `portal-gcp/` stack inside the
platform repo, so its card carries the platform repo plus `context_dir = portal-gcp`.
For that platform-repo case the preflight also accepts the `iap-lb` module at the repo
root (`iac/modules/iap-lb/main.tf`) instead of vendored under the subdirectory. The
value is validated before use ('..', a leading `/`, and backslashes are rejected), and
the default `.` leaves root-layout app deploys exactly as before.

## Per-app prerequisites (before first deploy of that app)

- The app repo is private in the org and contains a root `Dockerfile` plus the `iac/`
  stack with `iap-lb` vendored in (onboard-app skill output).
- Any API-key secrets seeded in Secret Manager, values supplied out of band.
  Exception: outbound email needs no per-app secret - the platform provides a shared
  Resend key (`email-api-key`) plus SMTP settings as landing-zone outputs; apps send
  as `<app-slug>@<email_from_domain>` (see the skill's
  [secrets.md](../skills/onboard-app/references/secrets.md), "Platform email").
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
  A `ref` that is a full 40-char commit sha is treated as a pinned commit (the portal's
  "deploy a previous head" action): the same commits API verifies the exact sha exists
  (a bare sha is not an advertised ref, so `git ls-remote` could never find it) and the
  error message drops the rename recipe, which only makes sense for branch names.
  Branch and tag refs behave exactly as before.
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

## The pre-migration database export

Between the image push and the tofu applies, the workflow exports the app's own
database - and only that one - to the landing zone's export bucket:

```
gs://<workload>-db-pre-deploy-<token>/pre-deploy/<slug>/<image_tag>-<utc timestamp>.sql.gz
```

App migrations run when the new Cloud Run revision boots, i.e. during the applies, so
this is the last moment the schema is untouched. It exists because the shared Cloud SQL
instance is the wrong rollback unit for a deploy: restoring an instance backup would
roll back every app on it to recover one. The dump is the per-app rollback point;
nightly instance backups + 7-day PITR (in `iac/gcp/database.tf`) cover the
instance-level disaster story. Objects expire after 30 days - the dump is rollback
insurance for the deploy that just happened, not an archive. Right after the export the
workflow stamps custom metadata onto the object - `deployed_sha`, `deployed_ref`,
`github_run_id`, `app_slug` - so the portal can join `github_run_id` to its deployments
table and pair each backup with the deploy that took it (a failed stamp fails the job,
because an anonymous dump is unusable downstream).

Behaviour to know:

- **First deploy of an app skips the export.** The app stack self-provisions its
  database on the first apply, so before that there is nothing to dump; the step
  probes for the database and logs the skip. Once the database exists, a failed
  export **fails the job** before the applies run - an existing database with no
  fresh rollback point must not deploy.
- **The export runs on the instance, not serverless.** `--offload` was tried and
  dropped: serverless export pays a fixed multi-minute spin-up per run, which dwarfs
  the inline dump at current sizes. Reconsider it only if an app's database grows
  enough for an inline dump to load the shared instance.
- **No new credentials.** The CI identity's `roles/cloudsql.admin` (bootstrap) covers
  the export call; the object write is performed by the Cloud SQL instance's own
  service account, which the landing zone grants `roles/storage.objectAdmin` on the
  bucket.

To roll one app back from a dump (no other app is touched), use the
`restore-app-db` workflow described in the next section. The raw command it wraps,
for a fully manual restore:

```sh
gcloud sql import sql <instance> gs://<bucket>/pre-deploy/<slug>/<file>.sql.gz \
  --database <db> --user <db>_app --project <project>
```

(`<db>` is the slug with hyphens as underscores.) Dumps are exported with
`--clean --if-exists`, so they DROP and recreate every object they contain and
restore in place - but ONLY when imported as the user that owns the objects,
hence `--user <db>_app` (Cloud SQL rejects the DROPs otherwise). Dumps exported
before the `--clean` change are plain SQL: they do not drop what they did not
create, and restoring one needs the damaged objects dropped or recreated first.

## Restoring a database from a pre-deploy export

[`restore-app-db.yml`](../.github/workflows/restore-app-db.yml) is the operational
wrapper around the import above: it restores one app's database - and only that one -
from a pre-deploy dump. The portal is the normal dispatch surface (it lists an app's
dumps, pairs each with its deploy via the `github_run_id` metadata, and lets platform
admins trigger a restore); manual `workflow_dispatch` from the Actions tab is the
fallback. Inputs: `app_slug`, `backup_object` (the object path relative to the bucket,
e.g. `pre-deploy/myapp/abc123-20260717T080000Z.sql.gz`), and an optional
`requested_by` for the summary.

Step by step, the workflow:

1. **Validates the inputs against a closed charset**, and anchors `backup_object` to
   `pre-deploy/<slug>/...` for THIS run's slug - restoring app A from app B's dump is
   rejected before any GCP call, as is any path traversal.
2. **Preflights the repo variables and authenticates** via the same WIF identity as
   `deploy-app.yml` - no new credentials.
3. **Resolves the shared Cloud SQL instance and recomputes the bucket name** exactly
   as the export step does (exactly-one instance check; sha1-token bucket derivation).
4. **Verifies the backup object and the target database exist.** A missing object
   usually means the 30-day lifecycle expired it; a missing database means the app has
   never been deployed, which is an error - the restore will not create it.
5. **Takes a safety export first**: the CURRENT database is dumped to
   `pre-restore/<slug>/<utc>-before-restore.sql.gz` in the same bucket, stamped with
   `reason=pre-restore`, `restored_from=<backup_object>` and `github_run_id`. This is
   the guarantee the workflow is built around: if this export fails, the run fails
   before the import touches anything - a restore never runs without a way back.
6. **Imports the dump** with `gcloud sql import sql`, which blocks until done and
   fails nonzero on error.
7. **Rolls the app's Cloud Run service to a fresh revision** (a `wl-restore=<utc>`
   label bump on `<workload>-<slug>-<environment>`, the app-stack naming convention).
   The nudge exists because the restore changes the data under a running app: a fresh
   revision re-runs the app's boot migrations against the restored data and drops
   lingering connections holding stale state. If the service does not exist (or the
   roll fails), the run warns loudly instead of failing - the data restore has already
   succeeded by then, and the summary says so.

The run name follows the same portal contract as the other dispatch workflows:
`restore <slug> (<backup_object>)` - the portal locates the run it dispatched by the
`restore <slug> ` prefix, so the format is load-bearing. Restores are serialized per
slug (`concurrency.group: restore-<slug>`, queued not cancelled), like deploys.

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
