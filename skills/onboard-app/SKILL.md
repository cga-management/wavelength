---
name: onboard-app
description: Deploy a COPY of an app you already run locally onto the Wavelength platform (GCP). Use when a user has a working local app (its own DB, maybe Redis, API keys in a .env) and wants it hosted behind the platform's SSO perimeter with a slice of the shared database - not building a new app from scratch. Walks a coding agent through GitHub setup and getting the app into a private org repo, containerising, inheriting the IAP identity (no login code), taking a slice of the shared Postgres with per-user row isolation, moving API keys into Secret Manager, and deploying to scale-to-zero Cloud Run behind the shared IAP load balancer.
---

# Onboard an existing app to Wavelength (GCP)

You are helping a user host a **copy** of an app they already run locally. Assume they have
limited infra knowledge - you (the coding agent) do the work and tell them the few things
only a platform operator can do. The goal of onboarding is **Stage 1**: get the app running
**privately, behind SSO**, with its data in the **shared** platform database so the platform
can inspect and review it centrally. It is not a from-scratch build and it is not a public
launch.

> This skill is fully self-contained: everything you need is under `references/`,
> INCLUDING a vendored copy of the `iap-lb` OpenTofu module
> (`references/app-stack/modules/iap-lb/`) - no GitHub CLI, platform-repo access, or
> download step required. Some steps produce a **request to the platform operator**
> (clearly marked OPERATOR) that only someone with access to the platform can fulfil.

## The platform you are deploying onto (already exists)

- A shared **IAP perimeter**: an external HTTPS load balancer that authenticates every
  request against the org SSO (Workforce Identity Federation) before it reaches your app.
  After auth, IAP passes a signed JWT (`X-Goog-IAP-JWT-Assertion`) with the user identity.
- A shared **Cloud SQL for PostgreSQL** instance. Apps do NOT get their own database
  server - they get a **database on the shared instance**, their own database user, and a
  connection-string secret, all created by their own stack on FIRST deploy.
- A shared **app runtime service account** (already has `secretmanager.secretAccessor`,
  `cloudsql.client`, `artifactregistry.reader`). Your Cloud Run service runs as it.
- A shared **Artifact Registry** repo (Cloud Run pulls images from here).
- A shared **Cloud DNS** zone for a delegated subdomain (your app gets `‹app›.‹subdomain›`).
- A shared **admin registry**: the `wl_admin.platform_admins` table lists platform-wide
  admins. Your app treats a user as admin if they are in `platform_admins` OR are the
  deploying dev (the app OWNER).

## Minimal patterns (do these; do not invent more)

1. **Scale to zero.** Cloud Run `min instances = 0`. The app must boot cold on request and
   hold no in-process state between requests (use the shared DB, not local memory/Redis).
2. **IAP handles authentication; the app takes the username from the IAP JWT.** Do NOT
   build a login/auth flow for a custom app - read the verified user out of the IAP header.
   See `references/iap-identity.md`. (Exception: identity B below.)
3. **A slice of the shared DB, isolated per user.** Your app gets one database on the shared
   instance. Because the local app probably was not built for multiple users, add
   **username-driven row-level security** so each user only sees their own rows, and resolve
   **admin** from `wl_admin.platform_admins` OR the owner. See `references/shared-db-rls.md`.
   **Admin is an opt-in MODE, not an always-on view:** being owner/platform-admin is the
   ENTITLEMENT; admin powers apply only while the user has explicitly switched into admin
   mode (visible banner, defaults off each session). The owner uses the app as an ordinary
   user - seeing and touching only their own data - and flips into admin mode to *read*
   across users when supporting them. Admin is split along the read/write line: everyday
   admin mode reads all users' rows and writes shared reference data, while changing another
   user's data is a separate, audited **break-glass** step, not the everyday toggle. Details
   in `references/shared-db-rls.md`.
4. **API keys in Secret Manager, and use DIFFERENT keys for the deployed copy than local.**
   Never bake keys into the image or `.env`. See `references/secrets.md`.
5. **Private-first / fail closed.** Cloud Run ingress is internal (LB only); there is no
   public invoker. If a step fails, the app must stay unreachable, never publicly ungated.
6. **Log to stdout as structured JSON; keep user data out of logs.** The platform captures
   stdout/stderr to Cloud Logging automatically - do not write log files. Logs pool in a
   project-shared bucket (NOT isolated per app like the DB), so never log PII, secrets,
   tokens, or `DATABASE_URL`. See `references/logging.md`.
7. **UTC at rest, local at the glass.** Store and compute timestamps in UTC; render every
   human-facing timestamp in the viewer's timezone with the zone visible; label any cron
   or schedule field with the zone it is evaluated in.

**PII is deferred.** Onboarding is Stage 1 - the point is to get the data into the shared
space for central review. A formal PII assessment / conformance is a later platform-side
Stage 1->2 promotion gate the operator runs, not a blocker for you here.

## Pick the archetype first

An archetype is the full named combination (build mode, audience, identity, state); the
identity choice (A/B/C) is made within it. Pick from the five in
`references/archetypes.md` before touching code:

- **Custom user app** (default): source-built, human users, identity A (inherit the IAP
  identity; strip/skip the app's login). The typical internal tool / CRUD app - follow
  all steps below.
- **Packaged user app**: prebuilt image (e.g. WordPress), human users, identity B (the
  app keeps its own login behind IAP). You still do steps 1, 3 (shared DB), 4 (secrets),
  5, and the deploy - but you do NOT wire the IAP identity into the app's auth.
- **Connector service**: called by an Anthropic MCP connector, not a browser; identity C
  (connector OAuth). See `references/mcp-app.md` and `references/connector-oauth.md`.
- **Internal service**: called only by sibling platform apps; no human route.
- **Dual-audience app**: a human route AND a connector route, path-split (e.g. Outline
  plus its MCP endpoint).

## Who does what (you need NO GCP access)

You (the coding agent, on the app side) do **GitHub + app code + the IaC stack files**, and
**push to the private org repo**. You never run `gcloud`, `docker`, or `tofu` - the
**platform pulls the repo and deploys it** with its own credentials (a deploy workflow in
the Wavelength repo, run by the operator). So the app owner needs a GitHub account + org
access, **not** a GCP account.

**You produce (and commit):** a `Dockerfile`, the app code changes (identity, DB/RLS, secret
*references*), the app's `iac/` stack (from `references/app-stack/`, with the `iap-lb` module
vendored in), and `.env.example`. No real secrets, tfvars values, or identifiers in the repo.

**The OPERATOR does (platform side):**
- Seeds the deployed-copy API key(s) into Secret Manager (you supply the values out of band,
  never in the repo - see `references/secrets.md`).
- Runs the platform **deploy workflow** (`deploy-app`) with the app repo, slug, hostname and
  owner email - it builds the image, applies the stack, and does the two-phase IAP audience.
  See `references/deploy.md`.
- If migrating existing data: loads the user's `pg_dump` into the app's DB via Cloud SQL GCS
  import and stamps ownership. See `references/data-migration.md`.

The DB slice needs NO operator step: the app's stack self-provisions its database, its own
database user, and the `‹app›-database-url` secret on first deploy (see
`references/app-stack/database.tf`). A one-time hardening SQL exists for the operator
(`references/db-hardening.md`), but it is not a deploy blocker.

You give the operator: the app slug, a desired hostname (`‹app›.‹subdomain›`), and the owner
email (the deploying dev). They own `project_id`, `region`, `state_bucket`, and the DNS zone.

## Step order

0. **GitHub + a private org repo.** The user may have no repo at all (code only on their
   laptop), or a personal/public one. Get the app into a **private repo inside the org**
   (`<your-org>`) first - the platform's private-repo guard requires it and CI runs from
   there. Walk them through account setup, org membership (an org owner must invite them -
   an OPERATOR step), and creating/moving the repo private. See `references/github-setup.md`.
1. **Understand the local app.** Find its entrypoint, framework, how it serves HTTP and on
   what port, how it talks to its DB, where it reads API keys, and whether it has a login.
   Decide the archetype, and the identity (A or B) within it.
2. **Containerise.** Add a `Dockerfile` if there isn't one, and a committed `.env.example`
   (real `.env` gitignored). Bind to `0.0.0.0:$PORT` (Cloud Run sets `PORT`).
   See `references/deploy.md`.
3. **Wire identity (identity A).** Add the IAP-JWT middleware; make the app read the
   current username from it and stop requiring its own login. `references/iap-identity.md`.
4. **Point at the shared DB + add per-user isolation, applied by BOOT MIGRATIONS.** Read
   `DATABASE_URL` from the injected secret env. The app MUST apply its schema AND its RLS
   idempotently at startup (`CREATE TABLE IF NOT EXISTS` etc., with retry/backoff) - the
   first deploy creates an empty database, and no operator will run SQL for you. Add the
   ownership column, the RLS policy, and the per-request `SET LOCAL app.current_username`;
   wire admin resolution. `references/shared-db-rls.md`.
5. **Move API keys to Secret Manager.** New keys for the deployed copy; reference them as
   Cloud Run secret env. `references/secrets.md`.
6. **Add the app's OpenTofu stack (committed, no secrets).** Copy `references/app-stack/`
   WHOLE into the app's `iac/` (this includes the vendored `modules/iap-lb/` - COMMIT it,
   the deploy fails without it) and rename `‹app›`. The stack takes its real values
   (project, hostname, etc.) from the platform at deploy time - you commit the `.tf` files,
   the module, and `instance.auto.tfvars.example`. Scale-to-zero, internal ingress, one
   `iap-lb` route (`enable_iap = true`). `references/app-stack/README.md`.
7. **Push, verify DONE, then hand off to the platform.** Commit and push. You do NOT
   deploy. Before telling the user to register the app card, run this read-only checklist
   and SHOW the user the results - the deploy workflow builds from what is PUSHED, not from
   your working tree, and a card can be deployed the moment it exists:
   ```bash
   git ls-remote --exit-code origin main >/dev/null && echo "OK branch main pushed"
   test -f Dockerfile                              && echo "OK Dockerfile"
   test -f iac/modules/iap-lb/main.tf              && echo "OK iap-lb module vendored"
   git ls-files --error-unmatch iac/modules/iap-lb/main.tf iac/modules/iap-lb/variables.tf \
     iac/modules/iap-lb/outputs.tf >/dev/null      && echo "OK module files committed"
   git ls-files --error-unmatch .env.example >/dev/null && echo "OK .env.example committed"
   [ -z "$(git ls-files .env)" ]                   && echo "OK no .env committed"
   git grep -q "X-Goog-IAP-JWT-Assertion" -- ':!iac' && echo "OK identity middleware present"
   git grep -qi "CREATE TABLE IF NOT EXISTS" -- ':!iac' && echo "OK boot migration present (schema+RLS applied at startup)"
   ```
   Every line must print OK (the identity-middleware line applies to identity A only -
   skip it for identity B, which keeps its own auth). Then give the operator the deployed-copy
   API key value(s), and print the CARD JSON so the user can paste it straight into the
   platform portal's register form (the keys match the form fields exactly - fill in the
   real values):
   ```json
   {
     "name": "My App",
     "slug": "myapp",
     "hostname": "myapp.<your-app-domain>",
     "repo": "<your-org>/myapp",
     "ref": "main",
     "description": "One sentence on what the app does.",
     "icon": "emoji or image URL",
     "docs_url": ""
   }
   ```
   Registering the card (or handing the same values to the operator) triggers the
   `deploy-app` workflow, which pulls the repo, builds the image, applies the stack (the
   first apply also creates the app's database, DB user, and DATABASE_URL secret), and
   wires the IAP audience. `references/deploy.md`.
8. **Verify** (browser only - no gcloud) against the checklist in `references/deploy.md`:
   sign in via IAP; the app sees your username; a second user cannot see your rows; admin
   sees all; the key comes from Secret Manager; it scales to zero.
9. **Migrate existing data (optional).** To bring the app's current local data across:
   `pg_dump` it locally, hand the dump to the operator, who loads it into the shared DB via
   Cloud SQL's GCS import and stamps ownership so per-user RLS shows it. See
   `references/data-migration.md`. (Private-IP DB + no user GCP access = this is an
   export-and-hand-off, not a direct connection.)

## Guardrails

- **You need no GCP access.** If you find yourself about to run `gcloud`/`docker`/`tofu`,
  stop - that is the platform's job. Your output is a pushed private repo, nothing more.
- Never enable IAP on the Cloud Run service itself, and never add an `allUsers` invoker to
  it - IAP is enforced on the LB backend; the service stays internal-ingress only.
- Never commit secrets, real identifiers, or `.env`. `.tfvars` and `.env` are gitignored.
- If the app must be reachable by a non-browser client (e.g. an Anthropic MCP connector),
  that is a separate IAP-bypass + IP-allowlist pattern layered on top of everything above.
  See `references/mcp-app.md` (IAP-off route + Anthropic-only Cloud Armor + connector OAuth);
  the one part only the operator can do is the non-IAP backend's invoker grant.
