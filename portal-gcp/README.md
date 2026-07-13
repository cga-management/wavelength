# portal-gcp - the Wavelength admin portal (control plane)

The platform's control plane: one card per app (what exists, who owns it, whether it is
deployed, what it costs, whether anyone uses it), the place apps enter the platform
(register open to all; first deploy is the platform-admin vetting gate), and the cost /
usage showback surface. Design canon: [docs/portal.md](../docs/portal.md),
[docs/cost-showback.md](../docs/cost-showback.md),
[docs/usage-telemetry.md](../docs/usage-telemetry.md).

A first-class platform stack, sibling of [`outline-gcp/`](../outline-gcp/README.md), NOT
an onboard-app tenant. It deviates from the tenant rules in exactly three ways: it uses the
shared `wl_admin` database directly (wl_admin IS the registry it manages), it holds one
narrowly-scoped GitHub token (`actions:write` on the platform repo) to dispatch
`deploy-app.yml`, and it holds one read-only cloud capability (Cloud Logging read) under a
dedicated SA - see below.

## Third sanctioned deviation: read-only Cloud Logging under a dedicated SA

The per-app **Logs** panel on a card shows an app's recent Cloud Run logs to its app admins
and to platform admins (same predicate as cost/usage). A live log read is in-request, so
it cannot be an out-of-process collector (Layer 2) the way cost and usage are - it is the
portal's one in-process cloud read. To keep that grant from cascading, the portal no longer
runs as the shared app SA (`id-wl-platform`, inherited by every tenant app). It runs as its
**own** dedicated service account, `id-wl-portal` ([`identity.tf`](identity.tf)):

- The one new capability is **`roles/logging.viewer`** (project-scoped, read-only). Per-app
  scoping is enforced in the app, not by IAM: the Logging filter pins
  `resource.labels.service_name` to the single service `wl-<slug>-platform`, and the route
  gates on `canSeeCostUsage` (app admins of that app + platform admins).
- The dedicated SA is scoped **no wider** than the shared SA it replaces. It re-declares
  the three roles the portal actually used - `cloudsql.client`, `artifactregistry.reader`,
  and secret access - but tightens secret access to **secretAccessor on the two portal
  secrets only** (`portal-database-url`, `portal-github-token`), where the shared SA had
  project-wide `secretAccessor`.
- Nothing the shared SA holds is removed. Tenant apps keep running as it; the portal simply
  stops relying on it. If the portal is compromised the attacker gains read-only log view
  and the existing GitHub-token + registry blast radius - **not** log-read across every
  tenant app, which is what a grant on the shared SA would have meant.
- The log read uses **no new npm dependency**: an access token from the GCP metadata server
  (the same credential-free pattern `src/github.js` uses), then a POST to the Cloud Logging
  REST API (`src/logs.js`). Nothing is stored, and no log **contents** are ever written to
  the portal's own logs - only one structured `logs viewed` line per view (slug + severity
  filter).

It still holds NO other cloud credentials.

## Layout

- **App** (`src/`, `Dockerfile`, `package.json`, `public/`): Node 22 + Express,
  server-rendered (no SPA - re-auth behind IAP is free). Idempotent boot migrations apply
  the full DDL. Identity from the IAP JWT (`src/identity.js`, the single cloud seam).
  Authorization enforced server-side (`src/authz.js`, the 12-row table). Deploy dispatch +
  run poll (`src/github.js`). One `audit_events` row per mutation (`src/repo.js`).
- **Collectors** (`src/collector/`): `cost.js` and `usage.js`, run as a Cloud Run Job
  under a dedicated scoped SA. Share the app image, different entrypoint
  (`node src/collector.js all`).
- **IaC** (flat `*.tf`): Cloud Run service + IAP LB + DNS, the portal DB user +
  `portal-database-url` secret, the `portal-github-token` secret (no version), and the
  collector SA + job + Cloud Scheduler.

## Deploy (operator-applied, v1)

The portal is applied by hand from this repo (like outline). Self-deploy through its own
card needs a context-dir input on `deploy-app.yml` (that workflow assumes the Dockerfile +
vendored `iap-lb` at the app-repo root; the portal keeps IaC flat and references the
in-repo module) - an upstream candidate, noted in `lib.tf`.

1. **Build + push the image** to Artifact Registry:
   ```bash
   AR=<REGION>-docker.pkg.dev/<PROJECT_ID>/ar-wl-platform
   docker build -t "$AR/portal:v1" .
   docker push "$AR/portal:v1"
   ```
2. **Phase 1 apply** (IAP audience empty; the portal fails closed until phase 2):
   ```bash
   tofu init -backend-config="bucket=wl-tfstate-<token>" -backend-config="prefix=gcp-portal"
   tofu apply   # uses instance.auto.tfvars
   ```
3. **Phase 2 apply** (wire the real IAP audience):
   ```bash
   tofu apply -var "iap_audience=$(tofu output -raw computed_iap_audience)"
   ```
4. **Verify**: `https://portal.<your-app-domain>` 302s to `auth.cloud.google` (your workforce pool);
   the `run.app` URL does not serve; Cloud Run logs show `migrations applied`.

## Operator steps still required

- **Seed the deploy-dispatch token** (enables the Deploy button):
  ```bash
  printf '%s' "$PAT" | gcloud secrets versions add portal-github-token --data-file=- --project=<PROJECT_ID>
  ```
  The PAT is a fine-grained token with **`actions: write` on
  `<your-org>/<your-platform-repo>` only**. Then set `github_token_wired = true` and
  re-apply so the token env is wired into the portal.
- **`APP_REPO_TOKEN` repo secret** on `<your-org>/<your-platform-repo>`: a fine-grained
  PAT/GitHub App token with `contents: read` on the org's app repos (needed by
  `deploy-app.yml` to check out app repos). See
  [docs/deploy-app-workflow.md](../docs/deploy-app-workflow.md).
- **Platform admin seed**: `bootstrap_admin_email` in the tfvars seeds
  `wl_admin.platform_admins` on boot. Add more via the portal's Platform admins screen.

## Two-phase IAP audience

The IAP JWT audience embeds the LB backend's numeric id, which does not exist until the
stack is applied once. Phase 1 applies with `iap_audience=""` (portal rejects all tokens);
phase 2 reads `computed_iap_audience` and re-applies. Mirrors `deploy-app.yml` and the
onboard-app app-stack.

## Local development

```bash
DATABASE_URL='postgresql://postgres:test@127.0.0.1:5432/wl_admin?sslmode=disable' \
APP_ENV=local PORTAL_BOOTSTRAP_ADMIN=you@example.com \
PORTAL_HOSTNAME=portal.<your-app-domain> PORTAL_APP_DOMAIN=<your-app-domain> \
npm start
```
`APP_ENV=local` trusts an `X-Dev-User` header instead of the IAP JWT (never set in the
deployed service). Provide a local Postgres (`wl_admin` db).
