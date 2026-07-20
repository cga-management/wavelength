# App archetypes: one platform contract, five recipes

Design document. Companion documents: [portal.md](portal.md) (the control plane),
[deploy-app-workflow.md](deploy-app-workflow.md) (the deploy pipeline's operator runbook),
and the [onboard-app skill](../skills/onboard-app/SKILL.md) (the agent that consumes the
recipes defined here). The skill-side map of this taxonomy is
[archetypes.md](../skills/onboard-app/references/archetypes.md); the app-layer
connector-OAuth reference is
[connector-oauth.md](../skills/onboard-app/references/connector-oauth.md); the prebuilt
recipe is [prebuilt-app.md](../skills/onboard-app/references/prebuilt-app.md).

This document extends the platform's vocabulary; it does not re-architect anything.
Workflow and portal changes it implies are recorded as contracts and deltas (section 11),
not implemented here.

## 1. The problem

Three incoming apps do not fit the names the platform currently has:

- **A WordPress dev site.** A prebuilt upstream image, its own login, MySQL-only. The
  onboard-app skill assumes a Dockerfile the workflow builds and a Postgres slice; neither
  holds.
- **Hindsight** (agent memory, github.com/vectorize-io/hindsight). A prebuilt image whose
  store is Postgres plus the pgvector extension, and whose callers are sibling apps and
  agents, not humans in a browser.
- **Aspected.** A prebuilt, licensed retrieval/RAG container, API-facing, pulled from a
  credentialed registry.

Two structural gaps sit underneath them:

1. **Prebuilt is welded to platform-managed.** The only way a prebuilt image reaches the
   platform today is [`update-platform-app.yml`](../.github/workflows/update-platform-app.yml),
   whose slug map is a closed allowlist of operator-owned stacks (currently Outline). A
   tenant cannot bring a prebuilt app at all: [`deploy-app.yml`](../.github/workflows/deploy-app.yml)
   hard-requires a Dockerfile in its onboarded-repo preflight. Build mode and management
   mode are independent axes that the current mechanisms happen to conflate.
2. **The agent-facing auth pattern is half-documented.** bullhorn-mcp has live-validated a
   full connector auth model (IAP for the human at the OAuth consent step, the app as its
   own OAuth 2.1 authorization server for the connector, Cloud Armor anthropic-only on the
   machine paths). The edge half exists as
   [mcp-app.md](../skills/onboard-app/references/mcp-app.md); the app-layer half lives only
   in bullhorn-mcp's source, with no name in the skill's decision guidance.

A future "brain" app (RAG + MCP + agents + memory with specialist routes) must be hostable
as a composition of whatever gets named here. That is context bounding the taxonomy, not a
design this document attempts (section 9 places it in one sentence).

## 2. The platform contract

There is **one platform contract and one pipeline**, and every tenant app flows through it
regardless of archetype:

1. **A private org repo carrying `iac/`.** Every app, prebuilt included, has a repo with a
   committed OpenTofu stack (the skill's
   [app-stack/](../skills/onboard-app/references/app-stack/) shape). For prebuilt apps the
   repo is skill-generated and holds `iac/` plus tfvars only, no Dockerfile.
2. **An image in Artifact Registry**, put there by build (docker build on the runner, as
   `deploy-app.yml` does today) or by mirror (pull upstream, retag, push, as
   `update-platform-app.yml` does today). Cloud Run only pulls from AR; the mirror is not
   optional.
3. **A two-phase tofu apply** ([deploy-app-workflow.md](deploy-app-workflow.md)): phase 1
   creates everything with an empty IAP audience, phase 2 re-applies with the computed
   audience once the LB backend id exists.
4. **A card in the registry** ([portal.md](portal.md)): the app's control-plane identity,
   ownership, deploy history, cost and usage.
5. **A hostname behind the shared LB.** Every app, including internal and agent-only ones.

There are **no archetype-shaped code paths in the platform**. The one mechanical fork the
pipeline itself must know about is build versus mirror (section 5); everything else an
archetype varies is expressed in the app's own `iac/` and the card's metadata.

The invariants, stated as checkable rules (these are what the vetting admin and any
conformance check verify, whatever the archetype):

- **Internal ingress, always.** The Cloud Run service is reachable only via the LB; any
  invoker grant exists solely so the LB path works (the IAP service agent, or the scoped
  org-policy exception for non-IAP backends per
  [mcp-app.md](../skills/onboard-app/references/mcp-app.md)). Never public ingress.
- **IAP or Cloud Armor on every route.** A route is either IAP-gated (human) or IAP-off
  with a default-deny Cloud Armor policy ([`iac/gcp-org/armor.tf`](../iac/gcp-org/armor.tf)).
  No route is bare.
- **Secrets by reference.** Secret Manager via `value_source.secret_key_ref`, never
  plaintext env or state ([secrets.md](../skills/onboard-app/references/secrets.md)).
- **Self-provisioned DB slice.** The app's stack creates its database, its own DB user,
  and its connection secret on first apply
  ([app-stack/database.tf](../skills/onboard-app/references/app-stack/database.tf)); no
  landing-zone edit per app.
- **A hostname for everything.** Internal and agent-only apps still get an LB route
  (Armor-locked, no IAP). Rationale: the hostname is the usage-telemetry join key, the
  cost-showback label follows the stack, and the uniform edge posture holds only if there
  are no LB-less services. Rejected alternative: direct service-to-service URLs for
  internal apps - cheaper per call, but it forks the edge posture, loses telemetry, and
  creates the platform's first unauditable path.

## 3. The version contract

The platform's moving parts drift apart silently: the skill is copied into user repos, the
generated stacks are committed and age, and the workflows evolve in this repo. The drift
has already bitten - real onboarding failures traced to users holding an older copy of the
skill that predated the branch-normalization step (the `master` versus `main` mismatch
that [deploy-app-workflow.md](deploy-app-workflow.md) records as the first thing a real
third-party onboarding hit, now guarded by SKILL.md step 7's "OK branch main pushed"
check and the workflow's ref-exists preflight). Nothing detected the stale skill; the
failure surfaced as a cryptic deploy error.

The contract, one number for the whole platform, not per-component:

- **`VERSION` at the platform repo root** is the source of truth, bumped on contract
  changes (workflow inputs, stack interface, skill steps). Minor bumps are additive;
  major bumps are incompatible.
- **SKILL.md frontmatter** declares the skill's own version and the platform version it
  was cut from.
- **Generated app repos are stamped**: the skill writes a committed
  `.wavelength/stamp.json` (skill version, platform version, archetype) at hand-off
  (SKILL.md step 7). The archetype lives here and in the card description by convention -
  no registry schema column, because the platform has no archetype-shaped behaviour to
  key off it.
- **`deploy-app.yml` preflight** compares the stamp against `VERSION`: warn on minor
  drift, fail on incompatible (major) mismatch, warn-only on a missing stamp so
  pre-contract repos keep deploying while they age out.
- **The portal onboarding wizard surfaces the current platform version.** The wizard
  (`portal-gcp/src/server.js`, `GET /onboard`; `portal-gcp/src/views.js`
  `onboardWizard`) is already where users obtain the skill - it deliberately points them
  at this instance's private platform repo so they get this instance's skill, not
  upstream's. That makes it the natural surface for "you are onboarding against platform
  vX.Y" and the place a stale copy gets caught before it costs a deploy.

None of this is implemented yet; it is a delta (section 11). The skill's frontmatter
declaration ships only together with the `VERSION` anchor, never ahead of it - the skill
has been burned before by referencing things that had not shipped.

## 4. Archetypes as recipes

The reframe this document exists to make: **an archetype is a recipe consumed by the
agent running the onboard-app skill, not a platform construct.** Each archetype has three
parts:

1. **Decision guidance** - the axes below, so the agent can classify the app in front of
   it.
2. **Stack fragments and references to compose** - canonical `.tf` fragments and skill
   references, copied verbatim, not paraphrased.
3. **A checkable definition of done** - what the vetting admin reviews at first deploy and
   what any conformance check re-verifies later.

Complexity per app therefore sits with the agent, bounded by the invariants of section 2
and the platform-admin vetting gate ([portal.md](portal.md)). The consistency risks of
agent-side recipes, and their mitigations: agents improvise, so the references are
canonical and fragments are lifted verbatim; copies drift, so the repo stamp records what
recipe and version produced the repo; vetting catches what the recipe missed, and the
definition-of-done checklist makes that review mechanical rather than heroic. Archetypes
multiply cheaply under this framing: a new one costs a reference doc and a checklist, not
platform machinery.

### The five axes

Each axis is anchored to a mechanism that already exists:

- **Build**: source-built (Dockerfile, the workflow builds) or prebuilt (upstream image
  mirrored into AR). The one fork the platform itself must know about.
- **Management**: platform (stack in this repo, operator-applied, image-only rolls via
  `update-platform-app.yml`) or tenant (app repo, `deploy-app.yml`, portal-gated).
- **Audience** (per route): human (IAP), connector (IAP off + Cloud Armor anthropic-only),
  internal (sibling apps; still hostname'd), or combinations via path-split
  ([mcp-app.md](../skills/onboard-app/references/mcp-app.md)).
- **Identity** (per route): **A** inherit the IAP JWT
  ([iap-identity.md](../skills/onboard-app/references/iap-identity.md)); **B** the app's
  own login behind IAP ([outline-gcp/oidc.tf](../outline-gcp/oidc.tf) is the
  federate-to-the-same-IdP precedent); **C** connector OAuth anchored at the IAP-gated
  `/oauth/authorize` (section 8). C is A's machine-path sibling: in both, the IAP JWT is
  the only identity root.
- **State**: shared Postgres slice (default), +pgvector, MySQL (gated, upstream RFC #52),
  +bucket (gcsfuse, [outline-gcp/storage.tf](../outline-gcp/storage.tf) precedent), or
  stateless. Section 7.

Vocabulary rule: "archetype" always means a full named combination below. The old
"archetype A/B" naming in the skill is re-worded to "identity A/B" - the auth choice is
one axis, not the whole recipe.

### The five archetypes

1. **Custom user app** - source-built, tenant, human audience, identity A, Postgres
   slice. Today's default path; the skill's main line.
2. **Packaged user app** - prebuilt, tenant, human audience, identity B. WordPress is the
   motivating case; Outline is its platform-managed cousin. Recipe:
   [prebuilt-app.md](../skills/onboard-app/references/prebuilt-app.md).
3. **Connector service** - tenant, connector audience, identity C; source-built
   (bullhorn-mcp, the live validation) or prebuilt. Recipes:
   [mcp-app.md](../skills/onboard-app/references/mcp-app.md) (edge) +
   [connector-oauth.md](../skills/onboard-app/references/connector-oauth.md) (app layer).
4. **Internal service** - tenant, internal audience, service identity, usually
   +pgvector. Hindsight and Aspected.
5. **Dual-audience app** - human + connector on one service, path-split (mcp-app.md
   topology 2). Live example: Outline UI + Outline MCP
   ([outline-gcp/lb.tf](../outline-gcp/lb.tf)).

### Compatibility matrix

Cells: **exists** (live mechanism, cited), **gap-closed-here** (contract stated in this
document, implementation is a section 11 delta), **out-of-scope** (owned elsewhere).

| Archetype | Build + deploy | Edge (routes) | Identity | State | Lifecycle |
|---|---|---|---|---|---|
| Custom user app | exists (`deploy-app.yml` source mode) | exists ([app-stack/lb.tf](../skills/onboard-app/references/app-stack/lb.tf)) | exists (A, iap-identity.md) | exists ([app-stack/database.tf](../skills/onboard-app/references/app-stack/database.tf)) | exists (redeploy on push; `deploy_schedules` in `portal-gcp/src/db.js`) |
| Packaged user app | gap-closed-here (prebuilt tenant mode, section 5) | exists (single IAP route) | exists (B; [outline-gcp/oidc.tf](../outline-gcp/oidc.tf) precedent) | Postgres exists; MySQL out-of-scope (upstream RFC #52); bucket exists ([outline-gcp/storage.tf](../outline-gcp/storage.tf)) | gap-closed-here (detect/approve/roll generalized, section 6) |
| Connector service | exists for source (bullhorn-mcp); gap-closed-here for prebuilt | exists (mcp-app.md topology 1; [iac/gcp-org/armor.tf](../iac/gcp-org/armor.tf)) | gap-closed-here as a named recipe (C; connector-oauth.md) | exists (Postgres slice; the four `oauth_*` tables live in it) | exists |
| Internal service | gap-closed-here (prebuilt tenant mode) | gap-closed-here (internal-audience Armor policy, section 9) | service identity; per-app runtime SA is an open question (section 11) | gap-closed-here (+pgvector rules, section 7) | gap-closed-here |
| Dual-audience app | exists (platform-managed: Outline; tenant: bullhorn-mcp) | exists ([outline-gcp/lb.tf](../outline-gcp/lb.tf), mcp-app.md topology 2) | exists (B or A on the human host, C on the machine paths) | exists | exists (`update-platform-app.yml` for the platform-managed case) |

## 5. Decision: prebuilt tenant apps

Prebuilt apps become deployable by tenants through the **same** `deploy-app.yml`, in a
prebuilt mode that changes exactly one stage of the pipeline:

- **New optional input `upstream_image`**: the untagged upstream image path
  (e.g. `docker.io/outlinewiki/outline`). When set, **`image_tag` becomes required and
  strict `x.y.z`** - prebuilt apps are always pinned; there is no "latest".
- **The Dockerfile preflight is skipped; the `iac/` preflight is kept.** A prebuilt repo
  is `iac/` plus tfvars by construction; it must still be a complete, vendored stack.
- **The mirror step replaces the build step**, lifted from `update-platform-app.yml`:
  pull `upstream_image:image_tag`, retag as `AR/<slug>:<image_tag>`, push. The pull
  failing fast is the "does this release exist" check. The run **records the mirrored
  image digest** in the job summary, so "what exactly did we deploy" survives upstream
  re-tagging.
- **Everything downstream is unchanged**: two-phase apply, self-provisioned DB slice, LB
  route, DNS, card, vetting. First-deploy vetting means vetting the pinned image and the
  generated `iac/` - the same review, different artifact.

Portal routing reuses the columns that already exist in `portal-gcp/src/db.js`
(`upstream_repo`, `current_version`, `available_version`, plus one new `upstream_image`
column):

| `upstream_repo` | `repo` | Meaning | Update dispatches |
|---|---|---|---|
| non-null | null | platform-managed (unchanged, e.g. Outline) | `update-platform-app.yml` (closed allowlist) |
| non-null | non-null | prebuilt tenant app | `deploy-app.yml` with `image_tag = available_version` |
| null | non-null | source-built tenant app (unchanged) | `deploy-app.yml` with a git ref |

Release detection and the approve flow generalize for free: the scheduler's existing
upstream watcher (`portal-gcp/src/scheduler.js`, `checkUpstreamReleases`) already keys on
a non-null `upstream_repo` and writes `available_version`; only the dispatch target
differs by row shape.

Two explicit rejections:

1. **Rejected: opening `update-platform-app.yml` to registry-driven slugs.** It would
   have been the smaller diff: let the portal's rows define the slug map. But the closed
   allowlist is a trust statement, not a stub - `update-platform-app.yml` rolls images
   onto **operator-owned** services, and a registry-driven map would mean portal-writable
   rows steering deploys of stacks the portal otherwise cannot touch, widening the
   portal's carefully-stated blast radius ([portal.md](portal.md): one token, one
   database, one log grant). Prebuilt tenant apps go through `deploy-app.yml`, where the
   tenant trust model, vetting gate, and per-slug concurrency already live.
2. **Rejected: repo-less, card-driven deploys for prebuilt apps.** The card-only UX
   ("type an image, get an app") is attractive and was seriously considered. Rejected
   now because it creates a second deployment model: infra shape would move out of git
   into portal-writable rows, every future knob would become a card field (flag creep),
   and rollback/audit would fork from the git-based story every other app has. The
   card-like UX is delivered by the skill instead: it generates the tiny repo (`iac/` +
   tfvars, no Dockerfile) from a compose file or bare image name, and the user never
   authors infra. If a real catalogue/app-store scenario emerges (many identical
   instances of vetted images), card-driven deploys are the natural evolution - the
   foundation-first order is deliberate: repos and stamps now, catalogue later if earned.

## 6. Decision: lifecycle and stages

**Ref semantics split by stage, one lifecycle over both build modes.**

- **Source-built apps default to `ref: main` at Stage 1.** Stage 1 is the fast loop
  (push, redeploy); the resolved sha is recorded per deploy (`deployments.sha`,
  `portal-gcp/src/db.js`), so "what was live on Tuesday" is answerable even without
  pinning. **Pinned release tags are the documented posture for stable or promoted
  apps**: cut a tag, set the card's ref to it, and redeploys become deliberate acts.
- **Prebuilt apps are always pinned** (strict `x.y.z` image tags - already true for the
  platform-managed case, carried into the tenant case by section 5).
- **One detect/approve/roll lifecycle over both modes.** Detect: the portal's upstream
  watcher, which generalizes from third-party `upstream_repo`s to the org's own app repos
  (open question, section 11). Approve: a human presses Update (or a
  `deploy_schedules` row fires). Roll: the mode-appropriate workflow. **Rollback is
  re-dispatch of the previous tag** - the previous image still sits in AR, and
  `update-platform-app.yml` additionally auto-rolls back within a run if the new revision
  never becomes ready.

The controls this stage split leans on, with their honest status:

- **Deploy schedules** (exists): one-off and recurring rows in `deploy_schedules`
  (`portal-gcp/src/db.js`), fired by the scheduler tick, crash-safe by advancing
  `next_fire_at` before dispatch.
- **The platform-admin vetting gate on first deploy** (exists): [portal.md](portal.md).
- **Rollback via previous tag/image** (exists, as above).
- **Pre-deploy per-database exports** (exists): `deploy-app.yml` exports the app's own
  database to the pre-deploy bucket (30-day retention) between the image push and the
  applies, skipping first deploys and failing closed otherwise
  ([deploy-app-workflow.md](deploy-app-workflow.md), "The pre-migration database
  export").
- **Nightly backups + PITR on the shared instance** (exists):
  [`iac/gcp/database.tf`](../iac/gcp/database.tf) enables automated nightly backups
  (02:00) and point-in-time recovery with seven-day log retention.

## 7. Decision: state on the shared data tier

**Default: a slice of the shared Postgres instance**, self-provisioned
([app-stack/database.tf](../skills/onboard-app/references/app-stack/database.tf)), with
the one-time hardening SQL of
[db-hardening.md](../skills/onboard-app/references/db-hardening.md).

**+pgvector: no landing-zone change.** `CREATE EXTENSION IF NOT EXISTS vector` succeeds
for the self-provisioned app user on the shared instance (API-created users are members
of `cloudsqlsuperuser`, and `vector` is on Cloud SQL's extension allowlist for
POSTGRES_16). The ordering rule: **create the extension before the db-hardening revoke**
runs, because the revoke strips the very membership that authorizes extension creation.
Hindsight specifically has been verified to **self-create the extension**: its boot
migrations (`hindsight-api-slim/hindsight_api/migrations.py`,
`_ensure_pgvector_extension_in_public`) check `pg_extension`, attempt
`CREATE EXTENSION vector` in the `public` schema, and raise only if the extension neither
exists nor can be created - so on a pre-hardening first boot it provisions itself, and on
a hardened slice it works if the extension was pre-created. One wrinkle: if it finds the
extension outside `public` it attempts a `DROP EXTENSION vector CASCADE` and re-create,
so pre-create it in `public` (the default) and the relocation path never fires. Honest
caveat: the shared instance's `db-f1-micro` tier makes pgvector **functional, not
performant** - fine for Hindsight-scale agent memory, wrong for serious ANN load.
`db_tier` in [`iac/gcp/database.tf`](../iac/gcp/database.tf) is the knob, and cost
showback ([cost-showback.md](cost-showback.md)) is how a tier bump gets justified.

**MySQL: gated, owned by upstream RFC #52.** The RFC scopes the gap for MySQL-only apps
(WordPress): a second, parallel Cloud SQL instance (`MYSQL_8_0`) on the same VPC, behind
`enable_mysql = false` (default), with the same private-IP-only and `ENCRYPTED_ONLY`
posture as the Postgres instance; app slices get **discrete `DB_HOST` / `DB_NAME` /
`DB_USER` / `DB_PASSWORD` secret fields** (not a URL DSN - the MySQL ecosystem reads
discrete vars), port 3306. The gate exists because a second Cloud SQL instance is a
standing always-on cost, unlike everything else on the platform, which scales to zero.
This document states that contract and does not re-argue it.

**+bucket: gcsfuse, bucket-per-app.** The org policy
(`constraints/iam.disableServiceAccountKeyCreation`) blocks HMAC keys and therefore the
S3-interop path, so file storage is a per-app GCS bucket mounted into the container with
gcsfuse and the app configured for "local" storage mode.
[outline-gcp/storage.tf](../outline-gcp/storage.tf) is the precedent to copy.

**Stateless** is allowed and still gets the full contract: repo, card, hostname.

## 8. Decision: identity C, the connector-OAuth service

Identity C is the machine-path sibling of identity A: the IAP JWT remains the only
identity root, verified at exactly one place. The invariants, in one paragraph: the app
is its own OAuth 2.1 authorization server, discoverable via RFC 8414 and RFC 9728
metadata, registering connectors dynamically via RFC 7591 as public PKCE clients (no
client secrets anywhere in the flow); tokens are 1 hour access / 60 day rotating refresh
with family revocation on replay outside a 60 second grace window; an unauthenticated
`/mcp` request answers **401 with a `WWW-Authenticate` challenge** (mandatory - without
it the connector never starts the flow); human identity enters **only** at the IAP-gated
`/oauth/authorize` (the one endpoint a browser visits, deliberately absent from the
path-override list), where the IAP JWT is verified fail-closed and the normalized email
is bound as owner on a single-use auth code; upstream (third-party) credentials are never
mixed into the connector flow - the two layers join only at write attribution. The edge
half is [mcp-app.md](../skills/onboard-app/references/mcp-app.md) (topologies, the shared
`anthropic-only` Armor policy in [`iac/gcp-org/armor.tf`](../iac/gcp-org/armor.tf)); the
app layer, liftable nearly verbatim from bullhorn-mcp, is
[connector-oauth.md](../skills/onboard-app/references/connector-oauth.md).

Two operator gotchas, both live-validated: the non-IAP machine backend has no IAP service
agent, so it needs the scoped `run.invoker` org-policy exception; and `IAP_AUDIENCE`
only becomes real in phase 2 of the two-phase apply - the app must fail closed while it
is empty.

## 9. Composite apps

A composite app is **one card and one Cloud Run service per component**, each component
classified independently against the axes. That is the whole design: portal, deploy,
cost, and usage already operate per service, so composition costs zero new machinery.
Each component takes its own DB slice by default (shared tables are a deliberate,
documented exception, not a default). Components call each other as the **internal
audience** behind the perimeter: hostname'd routes, IAP off, locked by a default-deny
Cloud Armor policy allowing only the platform's own egress - the `anthropic-only` pattern
of [`iac/gcp-org/armor.tf`](../iac/gcp-org/armor.tf) with the allowlist swapped, one more
shared org-edge policy (section 11).

The brain, placed in one sentence: a connector service (identity C front door) composed
with an internal memory service (the Hindsight archetype) and an internal retrieval
service (the Aspected archetype).

## 10. Explicitly unchanged

- **Platform components stay a closed, operator-applied set.** The portal, Outline, the
  landing zone, and the org edge do not become tenant apps, and
  `update-platform-app.yml` keeps its closed allowlist.
- **Identity A and B semantics are unchanged.** Only the naming moves (from "archetype
  A/B" to "identity A/B"); every existing app classifies identically.
- **The source mode of `deploy-app.yml` is unchanged.** Prebuilt mode is additive;
  a blank `upstream_image` leaves today's behaviour byte-for-byte.
- **No new trust boundary.** Tenant deploys stay behind the vetting gate; the portal's
  blast radius statement in [portal.md](portal.md) still holds verbatim.

## 11. Platform deltas and open questions

File-by-file deltas this document commits to (recorded, not implemented here):

| File | Delta |
|---|---|
| [`.github/workflows/deploy-app.yml`](../.github/workflows/deploy-app.yml) | prebuilt mode: `upstream_image` input, strict-tag validation, mirror step in place of build, Dockerfile preflight skipped when set, mirrored digest in the summary. Stamp preflight (warn minor / fail major / warn missing). |
| `VERSION` (new, repo root) | the platform version anchor of section 3; SKILL.md frontmatter declares against it in the same change. |
| `portal-gcp/src/db.js` | new `upstream_image` column; the routing discriminator of section 5. |
| `portal-gcp/src/server.js`, `portal-gcp/src/views.js` | Update action routed by row shape (platform-managed vs prebuilt tenant); the wizard surfaces the current platform version. |
| `portal-gcp/src/github.js` | dispatch `deploy-app.yml` (with `image_tag = available_version`) for prebuilt tenant updates. |
| [`iac/gcp-org/armor.tf`](../iac/gcp-org/armor.tf) | a third shared policy for the internal audience: default-deny, allow platform egress only (section 9). |
| [`docs/deploy-app-workflow.md`](deploy-app-workflow.md) | prebuilt-mode addendum: inputs, the mirror, the vetting difference. |

Open questions, flagged not decided:

- **`auto_update` for prebuilt tenant apps.** The inert forward-compatibility flag on
  `deploy_schedules` (`portal-gcp/src/db.js`: "rendered, never yet honored") finds its
  first real use case: a recurring update schedule that follows `available_version`.
- **Aspected's registry pull credentials.** The mirror step needs a `docker login`
  against a credentialed registry; the natural shape is a per-app pull secret in Secret
  Manager consumed only by that step. Decide when Aspected onboards.
- **Per-app runtime service accounts.** All apps share one runtime SA today; the internal
  audience (service-to-service calls) accelerates the least-privilege follow-up already
  noted in [`iac/gcp/database.tf`](../iac/gcp/database.tf).
- **Vendored app-stack versus a platform-module reference for skill-generated prebuilt
  repos.** Vendoring (today's rule) makes repos self-contained but multiplies template
  drift across many tiny generated repos; a module reference inverts the trade. Flagged,
  not decided - the stamp of section 3 at least makes the drift measurable.
- **Generalizing release detection to the org's own app repos**, so source-built stable
  apps get the same detect/approve/roll loop as prebuilt ones.
