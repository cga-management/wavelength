# Org setup - GCP (step -2, run once per instance)

The prerequisite before [`create-project.sh`](create-project.sh) and
[`bootstrap.sh`](bootstrap.sh): a domain-managed Google Cloud **organization** rooted on
your own domain. Everything downstream
(folders, the dedicated project, the landing zone, the gateway) hangs off this org.

Human-run, console-plus-`gcloud`. Generic: substitute your own values for every
`<PLACEHOLDER>`. No identifiers are hardcoded, per [../README.md](../README.md).

## Placeholders

| Token | Meaning | Example |
|---|---|---|
| `<CLIENT_DOMAIN>` | Primary domain rooting the org | `example.com` |
| `<SUPER_ADMIN>` | Standalone break-glass super-admin login | `gcp-admin@example.com` |
| `<DAY_ADMIN>` | Day-to-day admin (real mailbox, ordinary user) | `andy@example.com` |
| `<RECOVERY_MAILBOX>` | Existing monitored mailbox for recovery/alerts | `it-alerts@example.com` |
| `<ORG_ID>` | Numeric org id (step 4) | `123456789012` |
| `<BILLING_ID>` | Billing account id (step 6) | `0X0X0X-0X0X0X-0X0X0X` |

## Why a managed org (and not the auto-created one)

When someone signs up for Google Cloud with a Google email and no Cloud Identity, GCP
auto-creates a **standalone organization** named `<username>-org` (free-form name, no
`directoryCustomerId`, "free-trial customers only"). Standalone orgs can be renamed but
**never to a domain name**, and have **no in-place conversion** to a domain-managed org.
So a standalone org is never the permanent home: create a proper **Cloud Identity** org
for `<CLIENT_DOMAIN>` and decommission any standalone org afterward. A managed org shows
`displayName: <CLIENT_DOMAIN>` and a populated `directoryCustomerId`.

## Secure-by-default org policies (read this before you grant anything)

New orgs ship **secure by default**: a set of org policies is **enforced from creation**
and inherited by every project. Observed enforced on a fresh org:

- **`iam.allowedPolicyMemberDomains`** (domain-restricted sharing) - IAM members must be
  in an allowed customer/domain. This **blocks granting any consumer `@gmail.com` or
  external-domain account a role** anywhere in the org or its billing, and **blocks
  `allUsers` / `allAuthenticatedUsers`** (so a migrated public Cloud Run service can't be
  re-made public without an exception). This single policy shapes most of the friction
  below - plan to act only with in-org identities.
- **`iam.disableServiceAccountKeyCreation`** and **`iam.disableServiceAccountKeyUpload`** -
  no SA keys can be created or uploaded. Existing keys keep working and are not aged out
  (unless `iam.serviceAccountKeyExpiryHours` is set - observed `allowAll`, i.e. no expiry).
  Key **rotation** therefore needs a break-glass exception (below).

Observed **not** enforced by default (verify per org): `compute.vmExternalIpAccess`
(`allowAll`), `compute.requireOsLogin`, `compute.requireShieldedVm`.

Inspect effective policy (enable the API first):
```bash
gcloud services enable orgpolicy.googleapis.com --project=<ANY_PROJECT>
gcloud org-policies describe <constraint> --effective --project=<PROJECT> --format="yaml(spec.rules)"
```
Set a **scoped exception** (e.g. to rotate an SA key, or allow a specific public service):
needs `roles/orgpolicy.policyAdmin` (Org Admin does **not** include it). Override at the
**project or folder** level, do the action, then re-enforce. Keep exceptions narrow.

## The admin identity model (three tiers)

Separate these deliberately - conflating them is the default mistake.

**Tier 1 - Super-admin: standalone, break-glass only.**
A Cloud Identity **super-admin** is a *directory-plane* role and grants **nothing** in GCP
IAM. Keep it as a dedicated standalone identity, hardware-MFA, credentials in Vault, used
only to bootstrap and recover - **no day-to-day GCP roles, not federated** (so it survives
federation breaking). It needs **no mailbox**; route its recovery/alerts to
`<RECOVERY_MAILBOX>`.

**Tier 2 - Day-to-day admin(s): ordinary users with real mailboxes.**
Normal Cloud Identity users (e.g. `<DAY_ADMIN>`) **with a real mailbox** (the domain's MX
points at M365 / Workspace), **created by the super-admin**, granted **Organization
Administrator** plus the companion roles below. All day-to-day work runs as these. They
must be on an **allowed domain** (the domain-restricted-sharing allow-list). Have **two**,
or a break-glass org-admin group, so you are never one lost account from console-only
recovery.

**Tier 3 - Automation + JIT.** The CI service account (GitHub OIDC -> Workload Identity
Federation, project-scoped role bundle, no stored secret) does deploys; humans get
**JIT/eligible** project access only. See [../../IDENTITY.md](../../IDENTITY.md).

**Organization Administrator is narrower than it looks** - grant the day-to-day admin (or
a group) the companion roles it actually needs:

| Capability | Role (Org Admin does NOT include it) |
|---|---|
| Manage org IAM/policy bindings | `roles/resourcemanager.organizationAdmin` (the base) |
| Create projects | `roles/resourcemanager.projectCreator` (auto-granted to the domain at org creation) |
| Delete projects | `roles/resourcemanager.projectDeleter` |
| Create workforce pools (WIF) | `roles/iam.workforcePoolAdmin` |
| Set / override org policies | `roles/orgpolicy.policyAdmin` |
| Link billing | `roles/billing.user` on the billing account |

**Mailbox lesson (this bites):** Cloud Identity Free accounts have **no mailbox**.
Project-owner **invitations** and Google security/billing mail go to the account's
*primary address*, **not** its recovery email - so they vanish for a no-mailbox account.
That is why the day-to-day admin lives on an MX-backed domain. If a no-mailbox account
*must* accept an invite, temporarily **alias its address onto an existing M365/Workspace
mailbox**, accept, then remove the alias.

## The 50-user Free cap counts directory accounts, not federated users

The Free cap counts only **managed user accounts in the directory** (site-based
licensing). It does **not** count Workforce Identity Federation users (syncless, no Google
account), **email aliases**, **groups**, or **service accounts**. A **suspended** user
still holds its seat until deleted. In practice only the super-admins + day-to-day admins
count - a handful, far below 50. Exceeding 50 needs Cloud Identity billing (Premium),
which the federated design avoids.

## Coexistence with an existing tenant

`<CLIENT_DOMAIN>` is often already verified in M365 / Entra (or Workspace). Google Cloud
Identity verifies the domain **independently** via its own TXT record and coexists: the
existing mail provider keeps its **MX**, and Cloud Identity Free provisions no mailbox, so
there is no mail conflict. Only ever add the Google TXT record; never touch MX. (This is
also what lets a `<DAY_ADMIN>` account have its mailbox on M365 while logging into GCP via
the Cloud Identity account of the same address - two separate credentials, one address.)

## Ownership posture

Two roles are involved (see [../../IDENTITY.md](../../IDENTITY.md)): your org / identity
admin keeps org / billing / tenant root, and the platform operator runs Wavelength inside a
dedicated project. These may be the same person on your own core tenant, where you are root
permanently, or split when the privileged role is held by a separate identity admin. Decide
before starting; the steps assume the operator can perform org-level actions.

## Procedure

### 1. DNS prep
Confirm access to `<CLIENT_DOMAIN>` DNS. Sign-up issues a TXT value to publish before
verification. Adding TXT does not affect existing MX.

### 2. Create Cloud Identity Free + verify the domain (console only)
1. Open the Cloud Identity Free sign-up (confirm the current URL against Google docs at
   run time; historically `https://workspace.google.com/signup/gcpidentity/welcome`).
2. Enter business name, country, `<CLIENT_DOMAIN>`.
3. Create the first super-admin `<SUPER_ADMIN>` (role name, not a person); recovery email
   `<RECOVERY_MAILBOX>`.
4. Publish the **TXT** record and wait for verification (minutes to ~1 hour).
5. Expect a warning that existing accounts use the domain - those are unmanaged consumer
   accounts (step 7).

### 3. Break-glass super-admins
- Create a second super-admin so there is no single point of failure.
- **Hardware MFA** on both; credentials in **Vault** (`<app>/<env>/<service>`, `chmod 600`).
- These hold **no** day-to-day GCP IAM (see the admin model). Leave them clean.

### 4. Trigger and confirm the org, then capture its id
**Activating the domain does NOT create the GCP org node.** It is auto-provisioned only
when a super-admin **opens `console.cloud.google.com` and accepts the Terms of Service**
(an `gcloud auth login` OAuth flow is not enough). Until then - and until you hold
`organizationAdmin` - `gcloud organizations list` returns `Listed 0 items.` even for the
right account, because **super-admin is not an IAM role** (directory and IAM planes are
separate; the only default grants are Project Creator + Billing Account Creator).

To find the org id while still blind to `list`, create a project and read its parent;
`describe` by id works even when `list` is empty:
```bash
gcloud projects create <BOOTSTRAP_PROJECT> --account=<SUPER_ADMIN>
gcloud projects describe <BOOTSTRAP_PROJECT> --account=<SUPER_ADMIN> --format="yaml(parent)"
gcloud organizations describe organizations/<ORG_ID> --account=<SUPER_ADMIN>
# expect: displayName: <CLIENT_DOMAIN>  AND  owner.directoryCustomerId populated
```

### 5. Create the day-to-day admin and bootstrap Org Admin
1. As `<SUPER_ADMIN>` in the **Admin console** (`admin.google.com`): **Directory -> Users
   -> Add** `<DAY_ADMIN>` as an **ordinary** user (not super-admin). Its mailbox arrives
   via the domain's MX, so it can receive invitations/alerts.
2. Bootstrap the **first** `organizationAdmin` grant from the **console** (only super-admin
   status is honored before any IAM exists): open
   `console.cloud.google.com/iam-admin/iam?organizationId=<ORG_ID>`, **Grant access**, add
   **`<DAY_ADMIN>`** (or a `gcp-org-admins@<CLIENT_DOMAIN>` group), role **Resource Manager
   -> Organization Administrator**. Grant to a **specific user/group - never the bare
   `<CLIENT_DOMAIN>` domain** (that makes every user an org admin).
3. Log `<DAY_ADMIN>` into the CLI (`gcloud auth login <DAY_ADMIN>`, ideally its own
   config). From here, day-to-day work runs as `<DAY_ADMIN>`, not the super-admin.
4. Grant the companion roles the day-to-day admin needs (it is org admin, so it can
   self-grant these via org IAM):
   ```bash
   for R in resourcemanager.projectCreator resourcemanager.projectDeleter \
            iam.workforcePoolAdmin orgpolicy.policyAdmin; do
     gcloud organizations add-iam-policy-binding <ORG_ID> \
       --member="user:<DAY_ADMIN>" --role="roles/$R" --condition=None --account=<DAY_ADMIN>
   done
   ```
5. Keep the super-admin clean: ensure it holds **no** `organizationAdmin` / project
   ownership (remove any bootstrap grants once `<DAY_ADMIN>` is confirmed working), and
   remove any temporary mailbox alias.

### 6. Attach billing
```bash
gcloud billing accounts list --account=<DAY_ADMIN>
```
If none, create one in the console on your payment method. Record `<BILLING_ID>`.

### 7. Claim existing `@<CLIENT_DOMAIN>` accounts (transfer tool)
Within ~12h of verification, unmanaged consumer accounts surface in **Admin console ->
Account -> Transfer tool for unmanaged users**. Send transfer requests; on acceptance each
becomes managed. Accounts on **other** domains (a personal `*@gmail.com`) cannot be claimed
and cannot be granted IAM anyway (domain-restricted sharing) - replace with managed
`@<CLIENT_DOMAIN>` accounts.

### 8. Baseline structure and guardrails
```bash
gcloud resource-manager folders create --display-name="wavelength" \
  --organization=<ORG_ID> --account=<DAY_ADMIN>
```
Org policies are managed as code in [../../gcp/policy.tf](../../gcp/policy.tf) behind
`enable_org_policies` (default off); apply after the landing-zone stand-up so they stay in
Terraform. The secure-by-default baseline is already enforced regardless.

## Verification checklist
- `gcloud organizations list --account=<DAY_ADMIN>` shows `<CLIENT_DOMAIN>` with a numeric id.
- `describe` shows `displayName: <CLIENT_DOMAIN>` + populated `owner.directoryCustomerId`.
- `<DAY_ADMIN>` is sole/group Organization Administrator and works from the CLI; the
  super-admin holds no day-to-day IAM and no mailbox alias.
- Two MFA-protected super-admins exist; credentials in Vault.
- A billing account is linkable.
- At least one folder exists under the org.
- Effective org policies inspected; any needed exceptions are scoped to project/folder.

## Next steps
1. [`create-project.sh`](create-project.sh) - dedicated project under the org/folder, link `<BILLING_ID>`.
2. [`bootstrap.sh`](bootstrap.sh) - state bucket + GitHub OIDC WIF + CI service account.
3. Landing zone [../../gcp/](../../gcp/), then the gateway `gateway-gcp/`.
4. Human SSO edge: Workforce Identity Federation to the Entra tenant + IAP.
- **Importing an existing project** into the org is a separate procedure with its own
  pitfalls (the move needs Owner; `SOLO_MUST_INVITE_OWNERS`; domain policy blocks a gmail
  bridge; `gcloud beta projects move`; the move preserves project id / IP / Secret Manager
  secrets / service accounts; relink billing after). See `MIGRATE-PROJECT.md`.

## Gotchas
- **Multi-login browser bleed:** with several Google accounts signed in, the console
  defaults to `authuser=0` and "flips" to the wrong one. Use a **dedicated Chrome profile**
  per admin identity, or pin `&authuser=<email>` in the URL, or an incognito window.
- **Invitations need a mailbox:** Cloud Identity Free accounts have none; invites/alerts to
  them are lost (recovery email does not catch them). Use the day-to-day admin's real
  mailbox, or temporarily alias the address onto an M365/Workspace mailbox.
- **Mail coexistence:** add only the Google TXT record; never touch MX.
- **Post-cutoff items to confirm live:** the Cloud Identity Free sign-up URL and the
  transfer-tool location in the current Admin console.
- **Standalone org cleanup is deferred:** do not delete an auto-created `<username>-org`
  until its resources are moved and the managed org is verified working.
