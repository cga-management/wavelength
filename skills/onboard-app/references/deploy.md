# Deploy: you push, the platform pulls and deploys

You (the app side) do **not** run `gcloud`, `docker`, or `tofu`. You produce artifacts and
push them to the private org repo; the **platform deploy workflow** (in the Wavelength repo,
run by the operator) pulls the repo and deploys it with the platform's own credentials.

## App-side: what to produce and push (no GCP access)

1. **Containerise.** Add a `Dockerfile` at the repo root that builds with no local Docker
   needed (the platform builds it via Cloud Build). Bind the server to `0.0.0.0` and honour
   Cloud Run's `$PORT` (default 8080); match the `container_port` in the stack's `run.tf`.
2. **No local-only state in the request path.** The service scales to zero and runs cold,
   possibly multiple instances - keep state in the shared DB, not in-process memory or a
   local Redis. (If the app truly needs Redis, flag it to the operator; it is a bigger change.)
3. **`.env.example`** committed with placeholder values; real `.env` gitignored.
4. **The `iac/` stack** from `app-stack/` (renamed, `iap-lb` vendored). Committed. It reads
   its real values at deploy time - do not commit a filled `instance.auto.tfvars`.
5. **Push** to the private org repo (`<your-org>/‹app›`).

Then hand the operator: the app **slug**, a desired **hostname** (`‹app›.‹subdomain›`), the
**owner email** (deploying dev), and the **deployed-copy API key value(s)** through a
secure channel (never in the repo). There is no DB handoff: the stack self-provisions the
app's database, DB user, and `DATABASE_URL` secret on first apply, and the app's boot
migrations create the schema - which is why boot migrations are mandatory, not SQL files
for someone else to run.

## Platform-side: what the operator/workflow does (for reference)

The operator runs the `deploy-app` workflow in the Wavelength repo
(`.github/workflows/deploy-app.yml`) with those inputs. Using the platform's federated CI
identity (no human keys), it:
1. Checks out your app repo at the given ref.
2. Builds the image with docker on the runner and pushes it to the shared Artifact
   Registry, tagged by your app's commit SHA (so every redeploy rolls a new revision).
3. `tofu init` (backend prefix `gcp-‹app›`) + `tofu apply` on your `iac/` stack, passing
   `project_id`, `region`, `state_bucket`, `app_hostname`, `app_owner_email`, `image_tag`.
   The first apply also creates the app's database, its own DB user, and the
   `‹app›-database-url` secret on the shared instance (`app-stack/database.tf`).
4. Reads the `computed_iap_audience` output from that apply, sets `iap_audience` to it, and
   re-applies so the app verifies IAP tokens (two-phase, automated in the workflow).
5. The stack creates the DNS A record; the Google-managed cert then provisions
   automatically once the hostname resolves (~15-60 min on first deploy).

Prerequisites the operator must have done once: seeded the API-key secret(s) and set up
the workflow's cross-repo read token (see the platform repo's deploy runbook). The DB
slice is NOT a prerequisite - it self-provisions on the first apply. After first deploy
the operator can run the one-time hardening SQL (`db-hardening.md`); the app does not
depend on it.

## Verification (browser only - no gcloud)

- Once the cert is ACTIVE, browse `https://‹app›.‹subdomain›` -> you are bounced to the org
  SSO sign-in (IAP), then land on the app. No app login prompt for archetype A.
- **Identity:** the app acts as YOUR signed-in user (from the IAP JWT), with no login code
  of its own (archetype A).
- **Isolation:** create a record; a second signed-in user cannot see it (username RLS).
- **Admin:** you (owner) and anyone in `wl_admin.platform_admins` can see all records.
- **Secrets:** the app's API key came from Secret Manager and differs from local.
- **Scale to zero:** after idle it holds no running instances; the next request cold-starts
  through IAP. (The operator can confirm with `gcloud run services describe`.)

## What this does NOT set up

Public access, custom auth for archetype A, MCP/machine endpoints, or a real PII assessment /
Stage-2 conformance promotion. Those are separate, deliberate follow-ups.
