# Onboarding a prebuilt app (upstream image, no Dockerfile)

Use this recipe when the app is an **upstream-published Docker image** you deploy as-is
(WordPress, Hindsight, Aspected class) rather than code you containerise. It is the
skill-side recipe behind the **packaged user app** archetype, and it also covers the
build/repo side of prebuilt **internal services** and prebuilt **connector services**
(see `archetypes.md` to pick the archetype; `docs/app-archetypes.md` in the platform repo
is the canonical architecture doc this recipe implements).

A prebuilt app is still a full tenant app: it gets a **private org repo**, it is
**registered as a card**, it is **deployed by the platform**, and it gets a hostname
behind the shared LB. What changes is the build half: there is **no Dockerfile and no
image build** - the platform **mirrors** a pinned upstream image tag into Artifact
Registry and the stack runs that. The repo the skill generates holds **`iac/` + the
tfvars example + the stamp file, nothing else**. If you find yourself writing app code
or a Dockerfile, stop - the app is source-built and you want the default path in
SKILL.md instead.

## Which base steps apply, which are replaced

Against the SKILL.md step order:

| Base step | Prebuilt |
|---|---|
| 0 GitHub + private org repo | **Applies.** The repo is skill-generated rather than moved from a laptop, but org membership, private visibility, and `github-setup.md` all hold. |
| 1 Understand the local app | **Replaced** by compose-file ingestion (below). |
| 2 Containerise | **Skipped.** No Dockerfile, ever. The image is upstream's. |
| 3 Wire identity | **Replaced** by identity B wiring (below). Never wire the IAP JWT into a prebuilt app. |
| 4 Shared DB + RLS boot migrations | **Replaced.** The DB slice still self-provisions (`app-stack/database.tf`), but you write no migrations and no RLS - the app ships its own schema, migrations, and user model. Isolation boundary = the per-app database, not per-user rows. |
| 5 Secrets in Secret Manager | **Applies.** Every secret-shaped compose env var becomes a Secret Manager reference (`secrets.md`). |
| 6 The `iac/` stack | **Applies**, with the prebuilt edits below (pinned tag, sidecar/volume/env fragments). |
| 7 Push, verify, card handoff | **Applies**, with the adapted checklist and card below (no Dockerfile check; a no-Dockerfile check instead). |
| 8 Verify in the browser | **Applies** (`deploy.md`), except the "no app login prompt" line - identity B apps show their own login (or a silent OIDC hop). |
| 9 Data migration | **Applies** where relevant (`data-migration.md`). |

## Input: a compose file or a bare image

The natural input is the app's `docker-compose.yml` - most self-hosted upstreams publish
one, and it encodes everything the card and stack need. A **bare image name + tag** is
also acceptable input; you then get port/env/volume needs from the upstream docs instead.

Parse the compose file and map each element:

| Compose element | Platform mapping |
|---|---|
| `image: wordpress:6.5.3` | The upstream image + **pinned tag**. Mirrored into Artifact Registry as `‹slug›:6.5.3`; the stack's `image_tag` carries the tag. |
| `ports: "8080:80"` | The **container** port (right-hand side) becomes `container_port` in `iac/run.tf` (and its startup probe). The host port is meaningless on Cloud Run. |
| `environment:` | `env` blocks in `run.tf`. Anything secret-shaped (passwords, keys, tokens, DSNs) becomes a Secret Manager reference via `value_source.secret_key_ref`, never a plaintext value (`secrets.md`). Plain config stays a literal `value`. |
| a `redis:` service | A **Redis sidecar container** in the same Cloud Run service - the Outline precedent, `outline-gcp/outline.tf`. Mirror the upstream redis image into AR too; no `ports` block on the sidecar; a TCP startup probe on 6379; the app container gets `depends_on = ["redis"]` and `REDIS_URL=redis://localhost:6379`. The sidecar is per-instance and ephemeral, so **pin the service to one instance** (`min = max = 1`) - that is a standing cost and the loss of scale-to-zero; flag it to the user. |
| a named volume on an uploads/media path | A **gcsfuse-mounted bucket**: `google_storage_bucket` + `objectAdmin` for the app SA + a `gcs` volume mounted at the container path, with the app's storage mode set to "local" - the Outline precedent, `outline-gcp/storage.tf`. Org policy blocks HMAC/S3-interop keys, so never reach for an S3-compatible storage mode. |
| a `postgres:`/`db:` service | The **shared Postgres slice** - drop the service entirely; `iac/database.tf` self-provisions the database, app user, and `‹slug›-database-url` secret on first apply. Wire the app's own DB env names to it (a URL-shaped var gets the `DATABASE_URL` secret directly; apps wanting discrete host/name/user/password vars need the DSN split into separate secrets). |
| a `mysql:`/`mariadb:` service | The **gated MySQL instance** (upstream RFC #52 on cga-management/wavelength): `enable_mysql` defaults false because a second Cloud SQL instance is a standing cost, so this is an OPERATOR gate to request, not a flag you set. Secret shape is **discrete `DB_HOST` / `DB_NAME` / `DB_USER` / `DB_PASSWORD` secrets, not a URL DSN**, port 3306. |
| `build:` | **Must not exist.** A build context means the app is source-built - use the default SKILL.md path. |
| `restart:`, `container_name`, host networking | Ignore; Cloud Run owns lifecycle and networking. |

Everything not listed follows the base skill unchanged: internal ingress, no public
invoker, scale to zero (unless the Redis pin above forces one instance), structured
logging to stdout (`logging.md`).

## The generated repo

Generate a private org repo named after the slug, containing exactly:

- `iac/` - the stack from `app-stack/` (module vendored, renamed, edited per this doc)
- `iac/instance.auto.tfvars.example` - with `image_tag = "x.y.z"` (the pinned tag)
- `WAVELENGTH` - the stamp file (below)
- `README.md` - one paragraph: what the app is, the upstream image, the pinned tag

No Dockerfile, no app code, no `.env.example` (there is no local run to configure - all
runtime config lives in `run.tf` as env blocks and secret references).

### Stack edits (`iac/`)

Beyond the usual rename of `myapp`:

- `main.tf`: `local.app_image` already reads `‹AR repo›/‹slug›:${var.image_tag}` - for a
  prebuilt app that tag is the **mirrored upstream release tag** (`6.5.3`), not a
  CI-built commit SHA. The AR path is identical either way; only how the image gets
  there differs (mirror vs build).
- `variables.tf`: set the `image_tag` default to the pinned `x.y.z` (never leave the
  `latest` default). A bare apply must deploy the vetted version.
- `run.tf`: set `container_port` to the compose port; add the env/secret blocks, and the
  sidecar/volume fragments where the compose file calls for them (copy the shapes from
  `outline-gcp/outline.tf` rather than inventing your own).
- Do not add a boot-migration requirement: the image's own startup behaviour stands.
  If the app migrates at boot (Outline does), a generous startup probe window makes
  "revision ready" mean "migrations completed" - keep the probe realistic.
- `lb.tf` stays one IAP route (`enable_iap = true`) for a packaged user app. Prebuilt
  internal/connector services swap the route posture per `archetypes.md` and
  `mcp-app.md`; a prebuilt app serving an MCP/connector path also needs
  `connector-oauth.md`.

## Pinned versions: detect, approve, roll

Prebuilt apps are **always pinned to a strict `x.y.z` upstream tag - never `latest`**,
never a floating major/minor tag. The tag appears in exactly two committed places (the
tfvars example and the README) plus the card handoff.

The lifecycle after first deploy is **detect, approve, roll**: the portal watches the
upstream repo's releases, surfaces the new version, a platform admin approves it, and
the image rolls (mirror the new tag, roll the service). Rollback is re-dispatching the
previous tag. You do not chase upstream releases from the app repo.

That gives a deliberate **version-of-record split**:

- **git (the app repo) holds the stack shape** - ports, env, secrets, sidecars, volumes,
  routes. Changing the shape is a commit and a redeploy.
- **the portal registry holds the rolling image tag** - the currently deployed version
  advances through approve-and-roll without a commit per roll. The committed
  `image_tag` in the tfvars example is the first-deploy pin, not a live mirror of
  what is running.

(Contrast: platform-managed apps commit every tag bump back to the platform repo -
`update-platform-app.yml`'s final step. Tenant prebuilt apps deliberately do not.)

## Deploy: prebuilt mode (PENDING) and the interim operator path

**PENDING implementation.** `deploy-app.yml` is growing a prebuilt mode: an optional
`upstream_image` input (untagged image path) alongside a required strict `image_tag`;
when `upstream_image` is set the **mirror step replaces the build step**, the Dockerfile
preflight is skipped (the `iac/` preflight stays), and **everything downstream is
identical** - same two-phase apply, same self-provisioned DB slice, same card-driven
dispatch. The contract lives in `docs/app-archetypes.md`; do not assume it has landed.

Until it lands, the deploy is an OPERATOR action in two halves:

1. **Mirror the image** (same commands as the mirror step in
   `.github/workflows/update-platform-app.yml`):

   ```bash
   gcloud auth configure-docker "${REGION}-docker.pkg.dev" --quiet
   AR_IMAGE="${REGION}-docker.pkg.dev/${PROJECT_ID}/ar-${WORKLOAD}-${ENVIRONMENT}/‹slug›:‹x.y.z›"
   docker pull ‹upstream_image›:‹x.y.z›
   docker tag  ‹upstream_image›:‹x.y.z› "${AR_IMAGE}"
   docker push "${AR_IMAGE}"
   ```

   The pull fails fast if the tag does not exist upstream - that is the "does this
   release exist" check. (An upstream needing registry pull credentials, e.g. a
   licensed image, is an operator concern noted in `docs/app-archetypes.md`.)

2. **Apply the stack with the mirrored tag.** Today's `deploy-app.yml` hard-fails its
   Dockerfile preflight on a Dockerfile-less repo and always builds, so until prebuilt
   mode lands the deploy half is a supervised operator apply of the app's `iac/`: fill
   `instance.auto.tfvars` from the committed example (`image_tag` = the mirrored tag)
   and run the two-phase apply exactly as `app-stack/instance.auto.tfvars.example`
   describes. The moment prebuilt mode lands, this half becomes the normal
   `deploy-app.yml` dispatch (card-driven, `image_tag` = the approved version) and the
   manual apply retires.

## Identity B: the app keeps its own login

A prebuilt app has a real, load-bearing login you must not rip out - that is
**identity B** on the identity axis (`archetypes.md`): IAP is the outer gate blocking
unauthenticated traffic; the app still authenticates users itself, inside. Do NOT wire
the IAP JWT into the app (`iap-identity.md` does not apply), and drop the identity-A
env plumbing the app will never read (`IAP_AUDIENCE`, `APP_OWNER_EMAIL`) from `run.tf`.

The cost of identity B is a second sign-in. Where the app supports **OIDC, point it at
the org IdP** so the second sign-in is silent: the user authenticates once at the IAP
perimeter, and the app's OIDC login rides the same IdP session. `outline-gcp/oidc.tf`
is the worked example:

- The app gets its **own app registration** at the IdP (own redirect URI, own client
  secret) - do not reuse the IAP/workforce client or another app's registration.
- The **client secret goes in Secret Manager**, injected via
  `value_source.secret_key_ref` - never a plaintext env value.
- Watch the username claim: some IdPs (Entra) reliably emit `preferred_username`, not
  `email` - see the `OIDC_USERNAME_CLAIM` handling in `outline-gcp/outline.tf`.

If the app has no OIDC support (stock WordPress), the double sign-in stands at Stage 1;
an IdP plugin is a later improvement, not an onboarding blocker.

## State notes

- **pgvector** (Hindsight class): the extension must exist in the app's database. If
  the image runs `CREATE EXTENSION IF NOT EXISTS vector` itself at boot, that works on
  a fresh slice - the self-provisioned user can create extensions **only until the
  one-time hardening in `db-hardening.md` revokes its `cloudsqlsuperuser` membership**.
  So the ordering rule is: **extension before the hardening revoke**. If the image does
  not self-create it, it becomes a documented one-line OPERATOR step before first boot
  (in Cloud SQL Studio, connected to the `‹slug›` database):

  ```sql
  CREATE EXTENSION IF NOT EXISTS vector;
  ```

  Record which case applies in the repo README.
- **MySQL-only apps** (WordPress class): the gated second instance per upstream RFC #52
  - `enable_mysql` defaults false (standing cost), discrete
  `DB_HOST`/`DB_NAME`/`DB_USER`/`DB_PASSWORD` secrets rather than a URL DSN, port 3306.
  Request the gate from the operator; do not try to point the app at the Postgres
  instance.
- **Upload/media volumes**: the gcsfuse bucket pattern (`outline-gcp/storage.tf`) with
  the app's storage mode set to "local" at the mount path. Never local disk (revisions
  are ephemeral), never S3-interop (org policy blocks the HMAC key).

## The repo stamp

The generated repo carries a **`WAVELENGTH` stamp file at the repo root** - one
`key: value` line each, no other content:

```
skill: onboard-app
skill_version: ‹skill version from SKILL.md frontmatter›
platform_version: ‹platform version shown by the portal onboarding wizard›
archetype: packaged-user-app
generated: ‹YYYY-MM-DD›
```

Use the archetype slug that matches your choice from `archetypes.md`
(`packaged-user-app`, `internal-service`, `connector-service`). If the platform version
anchor has not shipped yet, write `platform_version: unversioned` rather than omitting
the line. The platform-side preflight that compares this stamp against the current
platform version is a **pending delta** (`docs/app-archetypes.md`) - stamp anyway, so
existing repos are checkable the day it lands.

## Hand off: verify and register the card

Mirror SKILL.md step 7, adapted. Run this read-only checklist from the repo root and
SHOW the user the results:

```bash
git ls-remote --exit-code origin main >/dev/null && echo "OK branch main pushed"
test ! -f Dockerfile                             && echo "OK no Dockerfile (prebuilt: mirrored, never built)"
test -f iac/main.tf                              && echo "OK iac/ stack present"
test -f iac/modules/iap-lb/main.tf               && echo "OK iap-lb module vendored"
git ls-files --error-unmatch iac/modules/iap-lb/main.tf iac/modules/iap-lb/variables.tf \
  iac/modules/iap-lb/outputs.tf >/dev/null       && echo "OK module files committed"
grep -Eq '^image_tag[[:space:]]*=[[:space:]]*"[0-9]+\.[0-9]+\.[0-9]+"' \
  iac/instance.auto.tfvars.example               && echo "OK pinned x.y.z tag present"
! grep -REn 'image_tag.*"(latest|stable)"' iac/  && echo "OK no floating tag anywhere in iac/"
test -f WAVELENGTH                               && echo "OK stamp file present"
[ -z "$(git ls-files .env '*.tfvars' | grep -v example)" ] && echo "OK no env/tfvars values committed"
```

Every line must print OK. Then give the operator the secret **values** out of band
(never in the repo), and print the CARD JSON for the portal register form:

```json
{
  "name": "My App",
  "slug": "myapp",
  "hostname": "myapp.<your-app-domain>",
  "repo": "<your-org>/myapp",
  "ref": "main",
  "description": "One sentence on what the app does. Archetype: packaged user app.",
  "icon": "emoji or image URL",
  "docs_url": "",
  "upstream_repo": "<upstream-org>/<upstream-repo>",
  "upstream_image": "docker.io/<publisher>/<image>"
}
```

The last two fields are the prebuilt additions: `upstream_repo` is what the portal's
release watcher follows for detect/approve/roll, `upstream_image` is what the mirror
step pulls. Until the portal register form grows them (pending with prebuilt mode),
hand those two values plus the pinned tag to the operator alongside the card.

## Definition of done

- The repo contains `iac/` (module vendored and committed) and **no Dockerfile** and no
  app code.
- The image tag is a strict upstream `x.y.z`, pinned in the tfvars example and handed
  over with the card; `latest` appears nowhere.
- Every secret-shaped value is a Secret Manager **reference**
  (`value_source.secret_key_ref`); no secret value is committed anywhere.
- The app's own login sits **behind an IAP route** (`enable_iap = true`); the Cloud Run
  service is internal-ingress with no public invoker.
- Where the app supports OIDC, it points at the org IdP with its own registration and
  the client secret in Secret Manager; otherwise the double sign-in is recorded as a
  known trade-off.
- Every compose-derived need is identified and wired: db engine (Postgres slice or the
  gated MySQL request), Redis sidecar (with the one-instance pin flagged), volume
  bucket (gcsfuse, storage mode "local"), required extensions (pgvector created before
  the `db-hardening.md` revoke, or the operator SQL line documented).
- The `WAVELENGTH` stamp file is present with skill version, platform version, and
  archetype.
- The card handoff includes the upstream repo and upstream image so detect/approve/roll
  can watch releases.
