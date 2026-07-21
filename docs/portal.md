# The admin portal: a control plane for apps

Design document (answers [RFC #19](https://github.com/cga-management/wavelength/issues/19),
builds on the deploy workflow proposed in
[RFC #17](https://github.com/cga-management/wavelength/issues/17)).
Companion documents: [cost-showback.md](cost-showback.md) and
[usage-telemetry.md](usage-telemetry.md).

The portal is one screen with one card per app: what exists on the platform, who owns it,
whether it is deployed, what it costs, and whether anyone uses it. It is also where apps
enter the platform: registration is open to any user, but nothing reaches the shared
perimeter until a platform admin presses Deploy once.

## Why the portal is platform, not a tenant app

The portal is the platform's **control plane**. It is a first-class platform stack -
[`portal-gcp/`](../portal-gcp/README.md), a sibling of
[`outline-gcp/`](../outline-gcp/README.md) - not an app onboarded through the
[onboard-app skill](../skills/onboard-app/SKILL.md). It deliberately deviates from the
tenant-app rules in exactly three ways, and no others:

1. **It uses the shared `wl_admin` database directly.** Tenant apps get their own slice
   ([shared-db-rls.md](../skills/onboard-app/references/shared-db-rls.md)); the portal
   does not, because `wl_admin` IS the registry it manages. The `platform_admins` table
   that every tenant app already reads (declared in
   [`iac/gcp/database.tf`](../iac/gcp/database.tf)) lives there; the portal adds the
   registry tables below alongside it.
2. **It holds one narrowly-scoped GitHub token** (`actions:write` on the platform repo,
   nothing else) to dispatch the platform deploy workflow.
3. **It holds a short list of narrowly scoped cloud grants under its OWN dedicated
   service account** (not the shared app runtime SA - a grant on the shared SA would
   cascade to every tenant app that inherits it; see `portal-gcp/identity.tf`):
   - `logging.viewer` (project, read-only), so app admins can see their app's runtime
     logs on its card. The live log tail is the single exception to the out-of-process
     rule below, because it cannot be a scheduled collector. Per-app scoping is enforced
     server-side (the same app-admin authorization as cost/usage, plus a service-name
     filter), nothing is stored, and log contents never enter the portal's own logs.
   - `storage.objectAdmin` on the pre-deploy dump bucket ONLY, so the Backups panel
     (below) can list an app's dumps and platform admins can delete one. Bucket-scoped
     deliberately: the portal holds no storage access beyond this single bucket.
   - `cloudsql.viewer` (project, read-only), so the Backups panel can show the shared
     instance's protection status (nightly backups, PITR). It carries no import, export,
     or data capability.

That is the whole blast radius: one GitHub token, one database, and the three scoped
grants above. The portal holds no other cloud credentials - it cannot run a Cloud SQL
import or export, cannot write to any app's database, holds no storage access outside
the one pre-deploy bucket, and cannot touch Cloud Run, IAM, billing, or state. Every
other cloud-facing action happens either in the deploy and restore workflows (under the
platform's federated CI identity) or in out-of-process collector jobs (under their own
scoped service account, see below). If the portal is fully compromised, the attacker can
dispatch deploys of repos an admin must still have vetted, dispatch restores of dumps
that already exist (the workflow safety-exports the current state first), read/write the
registry, read runtime logs (which the platform's logging rule already requires to be
free of user data), read Cloud SQL instance settings, and list or delete pre-deploy
dumps (bounded harm: dumps are 30-day rollback insurance, and nightly instance backups
plus PITR still stand behind them) - and that is all.

In every other respect the portal follows the tenant rules: Cloud Run behind the shared
IAP load balancer, scale to zero, internal ingress, identity from the IAP JWT
([iap-identity.md](../skills/onboard-app/references/iap-identity.md)), structured logs
with no user data ([logging.md](../skills/onboard-app/references/logging.md)).

## Three-layer architecture

The split is: **display and schema shared, population cloud-specific.**

```
            +---------------------------------------------------+
            |  Layer 1: neutral core (the portal app)           |
            |  schema, cards UI, authz, registry lifecycle,     |
            |  GitHub deploy dispatch. Knows no cloud.          |
            +-----------------------+---------------------------+
                        reads/writes|            ^ resolveIdentity(request)
                                    v            |   Layer 3: the ONE in-process
            +-----------------------+---------+  |   cloud seam (IAP adapter on
            |  wl_admin (shared Postgres)     |  |   GCP; Azure/AWS adapters
            |  apps, app_admins,              |  |   later, same contract)
            |  platform_admins, deployments,  |
            |  audit_events,                  |
            |  cost_snapshots, usage_snapshots|   <-- the TABLES are the contract
            +-----------------------+---------+
                                    ^ normalized rows (upsert)
                                    |
            +-----------------------+---------------------------+
            |  Layer 2: collectors (out-of-process, per cloud)  |
            |  scheduled jobs under a dedicated scoped SA:      |
            |  billing export -> cost_snapshots                 |
            |  LB/IAP logs    -> usage_snapshots                |
            +---------------------------------------------------+
```

**Layer 1 - neutral core.** Data schema, card display, authorization, registry lifecycle
(register, deploy, archive), and the GitHub deploy dispatch. It knows nothing about any
cloud: no GCP SDK, no billing API, no log queries.

**Layer 2 - population, cloud-specific, out-of-process.** Scheduled collector jobs per
cloud write normalized rows into the snapshot tables. On GCP: Cloud Scheduler triggering a
job that runs under a **dedicated, scoped service account, not the shared app runtime SA**.
The collector SA holds billing, BigQuery, and monitoring read roles; putting those on the
shared app SA would cascade billing-read to every tenant app on the platform, which is
exactly the grant creep the platform exists to prevent. The **tables are the contract**,
not a code interface: adding a cloud later means one collector job plus one IaC stack, and
zero changes to the core. Details in [cost-showback.md](cost-showback.md) and
[usage-telemetry.md](usage-telemetry.md).

**Layer 3 - the single in-process cloud seam.** One function:

```
resolveIdentity(request) -> { email, sub }   # email normalized; fail closed
```

On GCP this is IAP JWT verification exactly as
[iap-identity.md](../skills/onboard-app/references/iap-identity.md) specifies: there is no
top-level `email` claim behind Workforce Identity Federation, so the adapter resolves the
email from the `/subject/` suffix of `workforce_identity.iam_principal`, then normalizes
it with `normalize_owner_email` (strip control/zero-width, NFKC, trim, lowercase). No
email-shaped claim means 403, never anonymous. Azure and AWS get their own adapters later
(`X-MS-CLIENT-PRINCIPAL`, `x-amzn-oidc-*` respectively) satisfying the same contract; the
core never sees which one is in play.

## Role model

Three tiers, of which only one is global:

- **User** - any authenticated (IAP) user. Sees the deployed app cards (launch link,
  description, icon, docs URL), can open apps, and can **register** an app. Registration
  is open: no special group, no approval to file the request. Creating a card grants
  nothing (see the lifecycle below).
- **App Admin** - not a global tier but a **per-app relationship**. Registering an app
  makes you its owner and its first app admin. An app supports multiple app admins via
  the `app_admins` set; the owner is the default member, and platform admins can add
  members or transfer ownership. App admins see their app's cost and usage, can redeploy
  it after the gated first deploy, and can edit its metadata.
- **Platform Admin** - global, from the existing `wl_admin.platform_admins` table.
  Everything an app admin can do on every app, plus: portfolio-wide cost and usage,
  first-deploy approval, archive/restore, and managing the `platform_admins` set itself
  (the portal must refuse to delete the last row - a registry with zero platform admins
  is unrecoverable from inside the portal).

**Pending-card visibility.** A newly registered card is visible ONLY to its owner and to
platform admins. First deploy is admin-only: that is the vetting gate, and the reason the
portal exists - nothing reaches the shared perimeter without a platform admin having
looked at it once. After the first deploy the card becomes visible to all users and the
owner can redeploy at will.

**Portal roles are not in-app roles.** The portal's tiers govern the control plane: who
may deploy, archive, and see cost/usage. In-app data access is a separate model, the
decomposed RLS admin of
[shared-db-rls.md](../skills/onboard-app/references/shared-db-rls.md): `admin_mode` is
read-only visibility across users, `break_glass` is the audited cross-user write. The
same person may hold one without the other - a platform admin who can archive an app has
no automatic right to read its users' rows, and an app's in-app admin cannot necessarily
redeploy it.

## Authorization, action by action

Enforced **server-side**, keyed on the identity resolved by `resolveIdentity` - never on
anything the client asserts. "App Admin" below means for that specific app.

| Action | User | App Admin | Platform Admin |
|---|---|---|---|
| View deployed app cards | yes | yes | yes |
| View a pending (registered, not yet deployed) card | owner only | yes (own app) | yes |
| Open an app (follow its hostname link) | yes | yes | yes |
| Register an app | yes | yes | yes |
| Edit app metadata (name, description, icon, docs URL, ref) | no | yes | yes |
| First deploy (approve/publish) | no | **no** | yes |
| Redeploy (after first deploy) | no | yes | yes |
| Archive / restore | no | no | yes |
| Manage an app's admins (add/remove, transfer owner) | no | no | yes |
| Manage platform admins | no | no | yes (never delete the last row) |
| View an app's cost and usage | no | yes (own app) | yes |
| View portfolio cost and usage | no | no | yes |
| View an app's backups (dumps + instance protection) | no | yes (own app) | yes |
| Restore a backup (dispatch restore-app-db.yml) | no | yes | yes |
| Delete a backup object | no | no | yes |
| Deploy a pinned sha (any previous successful deploy) | no | no | yes |

Every mutating action in this table writes an `audit_events` row (schema below).

## Data model (Postgres, in `wl_admin`)

All email columns store the **normalized** form
(`normalize_owner_email`, [iap-identity.md](../skills/onboard-app/references/iap-identity.md));
comparing an unnormalized stored value against a normalized resolved one is the classic
silent-authz failure. Applied as idempotent boot migrations, same rule as tenant apps
([shared-db-rls.md](../skills/onboard-app/references/shared-db-rls.md)).

```sql
CREATE TABLE IF NOT EXISTS apps (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  slug           text NOT NULL UNIQUE,       -- immutable after first deploy
  name           text NOT NULL,
  description    text,
  icon           text,                       -- URL or emoji shorthand
  docs_url       text,
  repo           text,                       -- '<your-org>/<repo>'; NULL = link-only card
                                             -- (platform-managed app: discoverable, no deploy)
  ref            text,                       -- branch/tag/sha to deploy
  hostname       text NOT NULL UNIQUE,       -- 'app.labs.example.com'; the usage join key
  owner_email    text NOT NULL,              -- normalized
  status         text NOT NULL DEFAULT 'registered'
                 CHECK (status IN ('registered', 'deployed', 'archived')),
  archive_reason text,                       -- required when status = 'archived'
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

-- Per-app admin set. The owner is seeded as the first member at registration.
CREATE TABLE IF NOT EXISTS app_admins (
  app_id   bigint NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  email    text NOT NULL,                    -- normalized
  added_by text NOT NULL,                    -- normalized; 'system' for the owner seed
  added_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (app_id, email)
);

-- platform_admins already exists in wl_admin (see iac/gcp/database.tf); every tenant
-- app reads it for its admin entitlement. The portal manages it and MUST refuse to
-- delete the last remaining row.

-- One row per dispatch. Populated at dispatch time, then updated by a status poll
-- against the workflow run via the same GitHub token. Cards show the last outcome.
CREATE TABLE IF NOT EXISTS deployments (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  app_id        bigint NOT NULL REFERENCES apps(id) ON DELETE CASCADE,
  ref           text NOT NULL,
  sha           text,                        -- resolved commit, when known
  dispatched_by text NOT NULL,               -- normalized email
  github_run_id bigint,                      -- NULL until the run is located
  status        text NOT NULL DEFAULT 'dispatched'
                CHECK (status IN ('dispatched', 'running', 'success', 'failure', 'unknown')),
  created_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);

-- Every control-plane mutation writes exactly one row. Aligns with the platform
-- logging rule (skills/onboard-app/references/logging.md): event shape, actor, and
-- identifiers - never payloads or PII in `detail`.
CREATE TABLE IF NOT EXISTS audit_events (
  id           bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at           timestamptz NOT NULL DEFAULT now(),
  actor_email  text NOT NULL,                -- normalized
  action       text NOT NULL,                -- 'app.register', 'app.deploy', 'app.archive', ...
  subject_type text NOT NULL,                -- 'app', 'deployment', 'platform_admin', ...
  subject_id   text NOT NULL,
  detail       jsonb NOT NULL DEFAULT '{}'::jsonb
);
```

Notes:

- `slug` is unique and **immutable after first deploy** - it names the image, the tofu
  state prefix, the database, and the cost label; renaming it post-deploy would orphan all
  four. Reject edits server-side once `status` has ever been `deployed`.
- `repo IS NULL` marks a **link-only card**: a platform-managed app (the wiki, the
  gateway UI) that should be discoverable on the portal but has no deploy button.
- `archive_reason` is required at archive time (enforce in the application, since the
  column must stay NULL for non-archived rows).
- `cost_snapshots` and `usage_snapshots` also live in `wl_admin`; their DDL is in
  [cost-showback.md](cost-showback.md) and [usage-telemetry.md](usage-telemetry.md).

## Lifecycle

```
register (request) --> first deploy (admin approves) --> redeploys (owner) --> archive
      |                                                                          |
      +---- visible to owner + platform admins only ----+      restore <---------+
```

1. **Register.** Any user creates a card (repo, ref, slug, hostname, metadata). They
   become owner and first app admin. The card is a **request**: visible only to them and
   platform admins, deploy button admin-only.
2. **First deploy.** A platform admin reviews and presses Deploy. This is the approval
   and the publish in one act. On success the card flips to `deployed` and becomes
   visible to everyone.
3. **Redeploys.** The owner (or any app admin, or a platform admin) redeploys from the
   card whenever they push.
4. **Archive.** Platform-admin only, with a **required short reason**, recorded on the
   card and in the audit log. Archiving removes the card from the user view; it stays
   visible (badged) to its app admins and platform admins, and is restorable. Infra
   teardown is out of scope for v1 - scale-to-zero makes an idle app's runtime cost
   near-nil, so archive is sprawl control, not cost control.

**Usage drives archive.** The platform owners' question is "which apps earn their
place?"; [usage-telemetry.md](usage-telemetry.md) defines the signals (sustained
zero unique users is the archive-candidate signature) and
[cost-showback.md](cost-showback.md) the confirmation. Cost is confirmation, not trigger:
this is showback, never chargeback.

## The deploy dispatch contract

The Deploy button dispatches the platform deploy workflow
[`.github/workflows/deploy-app.yml`](../.github/workflows/deploy-app.yml)
(from [RFC #17](https://github.com/cga-management/wavelength/issues/17); its operator
runbook is [deploy-app-workflow.md](deploy-app-workflow.md), and the app-side view is
[deploy.md](../skills/onboard-app/references/deploy.md)) via the GitHub API:

```
POST /repos/<your-org>/<platform-repo>/actions/workflows/deploy-app.yml/dispatches
Authorization: Bearer <fine-grained PAT, actions:write on the platform repo only>
{
  "ref": "main",
  "inputs": {
    "app_repo":        "<your-org>/myapp",
    "ref":             "main",
    "app_slug":        "myapp",
    "app_hostname":    "myapp.labs.example.com",
    "app_owner_email": "dev@example.com"
  }
}
```

- **204 means accepted, not succeeded.** The dispatch API returns no run id. Record a
  `deployments` row as `dispatched`, then locate the run (the workflow's `run-name`
  embeds the slug precisely so it can be found and so the Actions list is legible) and
  poll its status with the same token, updating the row to
  `running`/`success`/`failure`. A run that can never be located ages out to `unknown` -
  surface that on the card rather than pretending.
- **Per-slug concurrency** is enforced by the workflow itself (one deploy per app,
  queued not cancelled - two concurrent applies would race the tofu state between the
  workflow's two apply phases). The portal may also grey the button while a deployment
  row for that slug is non-terminal, but the workflow's concurrency group is the real
  guarantee.
- The workflow validates its own inputs (ref exists, Dockerfile and vendored `iap-lb`
  module present) and routes them through `env:` rather than `${{ }}` interpolation, so
  a crafted card field is data, never shell. The portal still sanity-checks
  (slug shape, hostname within the platform subdomain) for UX, not for security.

## Backups

Every deploy already leaves a rollback point behind: `deploy-app.yml` exports the app's
own database to the landing zone's pre-deploy bucket between the image push and the
applies ([deploy-app-workflow.md](deploy-app-workflow.md), "The pre-migration database
export"), and the shared instance carries nightly backups plus 7-day PITR
([`iac/gcp/database.tf`](../iac/gcp/database.tf)). The Backups panel puts that material
on the app card. For owners and app admins it is read-only reassurance: their app's
dumps exist and the instance is protected. Platform admins additionally get three
actions: restore a dump (app admins - it overwrites only that app's database and a
safety export is taken first), delete a dump, and deploy a pinned sha. The authorization rows
are in the table above - `view_backups` for owner / app admin / platform admin;
`restore_backup` for app admins; `delete_backup` and `deploy_pinned` for platform
admins only.
Restores and deletes are destructive and a pinned deploy bypasses "head of the card's
ref", so all three sit at the same tier as archive.

**The pairing contract.** Every export object is stamped at export time with
`deployed_sha`, `deployed_ref`, `github_run_id`, and `app_slug`. The panel joins dumps
to the `deployments` table on `github_run_id` and renders each one two ways:

- **"taken before deploy #n"** - the deploy whose run exported it. The dump is taken
  before that run's revision boots, so before its migrations run.
- **"matching code: deploy #n-1"** - the latest earlier successful deployment, the code
  whose schema the dump actually matches.

That distinction is what makes restores safe to reason about. Under the platform's
expand/contract migration discipline
([shared-db-rls.md](../skills/onboard-app/references/shared-db-rls.md)) schema changes
are additive, so restoring a dump under the CURRENT code - a data-only restore - is the
common case and just works. A full rollback (bad migration, bad code and bad data
together) pairs the restore with redeploying the matching sha, which is exactly what the
previous-heads picker below exists for.

**The restore contract.** Platform-admin only, behind a typed confirmation (retype the
app slug - a restore overwrites live data, so a stray click must never be enough). The
portal writes a `deployments` row with `kind = 'restore'` (`ref` carries the backup
object name, so the deploy history reads honestly) and dispatches
[`restore-app-db.yml`](../.github/workflows/restore-app-db.yml) - the same trust shape
as deploy and update dispatch: `workflow_dispatch` under the portal's one
`actions:write` token, the run located by its `run-name` prefix (`restore <slug> `),
status polled into the row. The workflow guarantees safety-export, then import, then
revision nudge: it first exports the current database to the same bucket (so even a
mistaken restore is itself restorable), imports the chosen dump, and rolls the app's
Cloud Run revision so no instance keeps serving from stale connections or caches.

Explicitly rejected: the portal executing restores itself. It already reads the bucket,
and `gcloud sql import` is one API call away - but that call needs a destructive Cloud
SQL role, and granting it would break the blast-radius statement above for one
convenience. Imports stay under the CI identity via workflow dispatch: the portal
requests, CI executes, and a fully compromised portal still cannot import anything into
any database.

**Deploy a pinned sha.** Default deploy behaviour is unchanged: the Deploy button ships
the head of the card's ref. Platform admins additionally get a previous-heads picker -
any sha this app has previously deployed successfully (from `deployments`) - passed to
`deploy-app.yml`, which accepts an exact sha as `ref`. This is the redeploy half of a
full rollback, and it anticipates the pinned release/tag posture of
[app-archetypes.md](app-archetypes.md) section 6: today the picker is recovery,
tomorrow the same mechanism deploys tags deliberately.

**Delete.** Platform-admin only, a direct GCS delete under the portal SA's
bucket-scoped grant, audited (`audit_events` action `backup.delete`). The bucket's
30-day lifecycle rule remains the primary deleter; manual delete is hygiene (a corrupt
dump, an archived app's leftovers), not retention management - nobody should be
curating this bucket by hand.

## Time and timezones

One convention everywhere, ratified after a real incident (a user picked 10:00 in the
one-off schedule picker; the server read the zoneless wall-clock as UTC and the deploy
fired at 11:00 their time): **UTC at rest, local at the glass, explicit zone at every
boundary, recurring rules pinned to a named zone.**

**Store and compute in UTC, always.** Postgres `timestamptz`, the scheduler's fire
computation, dump stamps, audit rows: all UTC. Storage and code get exactly one clock to
reason about, and two instants compare without a conversion table. This was already true
and is now the rule, not a habit.

**Capture in the user's zone; convert at the edge.** `<input type="datetime-local">`
presents local wall-clock and posts a zoneless string - precisely the ambiguity behind
the incident. So the picker is labelled with the browser's resolved zone, client JS
converts the picked wall-clock to a UTC ISO-8601 instant before submit, and the form
echoes both readings ("fires at 09:00 UTC, 10:00 your time"). The server accepts ONLY
Z-suffixed instants for `run_at`: a JS-off submit fails with a clear error instead of
silently firing an hour off. Explicitly rejected: guessing the zone server-side (from
IP, Accept-Language, or a stored preference) - a guess that is right most of the time is
exactly how the wrong-hour class of bug survives review.

**Display in the viewer's zone, zone visible.** Every human-facing timestamp renders as
`<time datetime="<ISO-8601-UTC>">...UTC-labelled fallback...</time>` (`timeEl` in
views.js), and ONE small shared progressive-enhancement script (`public/time.js`, loaded
by the layout) rewrites them all to local time with a short zone suffix, keeping the UTC
string on `title` for hover. No framework: the portal stays plain server-rendered HTML,
and without JS the fallback stands - which is why every fallback must spell out "UTC".

**Recurring crons are evaluated in UTC and say so.** The field is labelled "Cron (UTC)"
and each active recurring schedule previews its next few computed fires (via cron.js's
existing `nextFire`) through the same `<time>` mechanism, so the user sees in their own
zone what "0 2 * * 1" actually means. A per-schedule timezone column is deliberately NOT
added now: it drags DST arithmetic into the dependency-free cron parser for a need no
current user has. It is the future extension for when a multi-timezone team needs it.

**Machine surfaces stay UTC.** Dump object names, workflow run names and summaries,
audit rows, structured logs: these exist for correlation and copy-paste, not reading,
and localizing them would break grep across systems. They keep their raw UTC form
untouched.

## Self-deploying

After a one-time manual bootstrap (the operator deploys the portal with the deploy
workflow by hand, then registers the portal's own card), the portal updates **through its
own card**: it is an ordinary registered app in its own registry, subject to exactly the
rules it enforces - its redeploys are dispatched by its app admins, its deployments are
recorded in `deployments`, its changes appear in `audit_events`. This is the pattern's
honesty check: if the portal needed a side door to update itself, the rules would not be
worth enforcing on anyone else.
