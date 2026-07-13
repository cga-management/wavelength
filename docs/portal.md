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
3. **It holds one read-only cloud capability: Cloud Logging read**, so app admins can see
   their app's runtime logs on its card. This is the single exception to the
   out-of-process rule below, because a live log tail cannot be a scheduled collector.
   To keep the grant from cascading to every tenant app, the portal runs as its OWN
   dedicated service account (not the shared app runtime SA) holding `logging.viewer`
   and nothing else cloud-side; per-app scoping is enforced server-side (the same
   app-admin authorization as cost/usage, plus a service-name filter), nothing is stored,
   and log contents never enter the portal's own logs.

That is the whole blast radius: one GitHub token, one database, one read-only log grant.
The portal holds no other cloud credentials - it cannot touch Cloud Run, IAM, billing, or
state. Every other cloud-facing action happens either in the deploy workflow (under the
platform's federated CI identity) or in out-of-process collector jobs (under their own
scoped service account, see below). If the portal is fully compromised, the attacker can
dispatch deploys of repos an admin must still have vetted, read/write the registry, and
read runtime logs (which the platform's logging rule already requires to be free of user
data) - and that is all.

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

## Self-deploying

After a one-time manual bootstrap (the operator deploys the portal with the deploy
workflow by hand, then registers the portal's own card), the portal updates **through its
own card**: it is an ordinary registered app in its own registry, subject to exactly the
rules it enforces - its redeploys are dispatched by its app admins, its deployments are
recorded in `deployments`, its changes appear in `audit_events`. This is the pattern's
honesty check: if the portal needed a side door to update itself, the rules would not be
worth enforcing on anyone else.
