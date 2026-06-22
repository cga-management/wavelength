# Wavelength - identity, roles and required privileges

Concrete, code-adjacent reference for the permissions a Wavelength instance needs. This
file is the operator's checklist and the per-cloud role specs.

The governing idea: standing up Wavelength splits into two roles, which may be two people
in your organization or one person wearing two hats. Your **org / identity admin** keeps
tenant / org / billing root. The **platform operator** runs Wavelength inside a
**dedicated project (GCP) / subscription (Azure)** that bounds the blast radius. Day-to-day
change flows through a **GitHub-federated CI identity** (no secret is ever shared or
stored). The operator holds **no standing privilege** - JIT elevation only. Everything is
revoked by deleting the dedicated container.

> v1 ships GCP. The Azure sections below are reference for the experimental Azure track
> (see ROADMAP.md), kept here so the trust model reads the same across clouds.

---

## Three trust zones

| Zone | Who owns it | What lives here |
|---|---|---|
| Org root | Your org / identity admin | Tenant (IdP) / org + billing. Subscription or project creation. App-registration creation. Stays with the identity admin. |
| Platform container | The operator works within | The dedicated subscription / project. All Wavelength resources. CI identity scoped here. |
| Pipeline | No human | GitHub Actions, federated to the container via OIDC. Builds and maintains the platform. No secret. |

---

## Privileges the org / identity admin must provide

### GCP

| # | What | Scope | Who performs | Why it cannot be narrower | Revoke by |
|---|---|---|---|---|---|
| G1 | Create a dedicated project under your org/folder and link billing | Org / folder + billing account | Org / billing admin | `resourcemanager.projects.create` + `billing.resourceAssociations.create` are org/billing-level, distinct from project Owner | Delete the project |
| G2 | Grant the CI service account the project role bundle below | The dedicated project | Identity admin (or delegated to the standup script once the SA exists) | The CI identity must create Cloud Run, Cloud SQL, Secret Manager, Artifact Registry, VPC + Private Service Access, the app SA and its bindings | Remove the bindings / delete the project |
| G3 | Make operators eligible for project roles via short-lived grants / IAM Conditions, via a Google group | The dedicated project | Identity admin | Break-glass only; no standing role | Remove from the group |

GCP has **no app-registration handoff** - Workload Identity Federation is project-scoped,
so the directory-object problem Azure has simply does not exist. This is a GCP onboarding
advantage.

### Azure (experimental track)

| # | What | Scope | Who performs | Why it cannot be narrower | Revoke by |
|---|---|---|---|---|---|
| A1 | Create a dedicated subscription, associate to your tenant, link billing | Billing account / MCA invoice section | Billing admin | Subscription creation is a billing-plane action, not RBAC | Cancel/delete the subscription |
| A2 | Create the app registrations from the specs below and return their IDs (+ one client secret into the platform Key Vault) | Entra tenant | Identity admin | App-registration creation is tenant-scoped; it escapes the subscription boundary, and most hardened tenants set "users can register applications = No" | Delete the app registrations |
| A3 | Grant the CI service principal the **Wavelength Platform Deployer** custom role (or the built-in bundle) on the dedicated subscription | The dedicated subscription | Identity admin (one role assignment) | The CI identity must create RGs, Key Vault, ACR, the Container Apps env, Postgres, VNet, role assignments for the workload identity, and policy assignments | Remove the role assignment / delete the federated credential |
| A4 | Make operators eligible (not active) for the Platform Deployer role via Entra PIM, as B2B guests | The dedicated subscription | Identity admin | Break-glass and operations the pipeline does not cover; eligible-only means no standing privilege | Remove PIM eligibility / remove the guest |

The operator does **not** need: Global Administrator, Application Administrator,
subscription Owner, or any management-group-level role.

---

## Azure app-registration specs (identity admin creates these)

The identity admin creates these; the IaC consumes them by ID as data sources and input
variables (see "IaC consequence" below).

**1. Platform CI (GitHub OIDC) - one-time.**
- Sign-in audience: this tenant only (`AzureADMyOrg`).
- No client secret. Add a **federated credential**: issuer `https://token.actions.githubusercontent.com`, subject `repo:<org>/wavelength:ref:refs/heads/main` and a second for `repo:<org>/wavelength:pull_request`, audience `api://AzureADTokenExchange`.
- Return: application (client) ID. Assign role A3 to its service principal.

**2. oauth2-proxy (gateway UI gate) - one-time.**
- Sign-in audience: `AzureADMyOrg`.
- Web redirect URI: `https://<gateway-ui-fqdn>/oauth2/callback`, ID-token issuance on.
- Create one client secret; place it directly in the platform Key Vault. The identity admin owns its rotation.
- Return: application (client) ID + the Key Vault secret name.

**3. Per Shared-tier app (EasyAuth) - recurring, one per app.**
- Sign-in audience: `AzureADMyOrg`.
- Web redirect URI: `https://<app-fqdn>/.auth/login/aad/callback`, ID-token issuance on.
- Allowed token audience: `api://<client-id>`.
- Return: application (client) ID.

**Recurring-friction note + the one relief valve.** Spec 3 means every new Shared-tier
app needs an identity-admin action. If you would rather the platform self-serve its own
app registrations, the single narrow grant that enables it is the Microsoft Graph
**`Application.ReadWrite.OwnedBy`** application permission on the CI app (create and manage
only apps it owns - nothing else in the directory, far below Application Administrator).
Default is admin-creates; OwnedBy is friction relief, your choice.

### IaC consequence

When the IdP app registrations are created externally (rather than by the IaC), the
`azuread` provider resources become **`data` sources + input variables** (`client_id`,
`object_id`, secret sourced from Key Vault), because the CI identity has no directory
rights. On GCP this is handled by `create_entra_app_registration = false` plus the
`oidc_*` inputs (see the `gcp-org`, `outline-gcp` and `gateway-gcp` variables).

---

## Role specs (hybrid: custom where built-in is too broad)

### GCP - CI service account role bundle (built-in; per `iac/bootstrap/gcp/bootstrap.sh`)

Project-scoped bindings on `<workload>-github-oidc@<project>.iam.gserviceaccount.com`:

```
roles/run.admin
roles/cloudsql.admin
roles/secretmanager.admin
roles/artifactregistry.admin
roles/compute.networkAdmin
roles/servicenetworking.networksAdmin
roles/iam.serviceAccountAdmin
roles/iam.serviceAccountUser
roles/resourcemanager.projectIamAdmin
roles/logging.admin
roles/cloudbuild.builds.editor
roles/storage.objectAdmin   # state bucket only
```

Candidate tightenings (future, only if a security review asks): `run.admin` ->
`run.developer` + `iam.securityAdmin`; otherwise these are already project-scoped and
named (no Owner). Org Policies (`iac/gcp/policy.tf`) are org-scoped and optional
(`enable_org_policies`, default off) - your call.

**Runtime workload identity (the app SA) stays minimal:** `secretmanager.secretAccessor`
+ `artifactregistry.reader` + `cloudsql.client`. See `iac/gcp/identity.tf`.

### Azure - Wavelength Platform Deployer (custom role, replaces Owner for CI)

Bundles exactly what the bootstrap and landing zone exercise; omits blanket Owner.
Built-in equivalent if a custom role is unwelcome: **Contributor + User Access
Administrator + Resource Policy Contributor** on the subscription, plus **Storage Blob
Data Contributor** on the state account.

Custom-role `actions` must cover, traced to the build:
- `Microsoft.Resources/*` (resource groups, deployments)
- `Microsoft.Storage/storageAccounts/*` (tfstate account + data plane for the container)
- `Microsoft.OperationalInsights/workspaces/*`
- `Microsoft.KeyVault/vaults/*`
- `Microsoft.ContainerRegistry/registries/*`
- `Microsoft.ManagedIdentity/userAssignedIdentities/*`
- `Microsoft.Network/virtualNetworks/*`, `.../privateDnsZones/*`
- `Microsoft.App/managedEnvironments/*`, `.../containerApps/*`
- `Microsoft.DBforPostgreSQL/flexibleServers/*`
- `Microsoft.Authorization/roleAssignments/write|delete|read` (grant the workload identity its KV/ACR roles - the User Access Administrator part)
- `Microsoft.Authorization/policyAssignments/*` (the guardrails - the Resource Policy Contributor part)
- `Microsoft.Insights/diagnosticSettings/*` (when diagnostics land)

`assignableScopes`: the dedicated subscription only.

**Runtime workload identity** stays minimal and built-in: Key Vault Secrets User (KV
scope) + AcrPull (ACR scope). This identity does not deploy anything.

---

## JIT elevation (humans eligible, pipelines active)

- **GCP:** operators sit in a Google group granted project roles via **IAM Conditions /
  short-lived access** (time-bound), no standing binding. The CI service account holds its
  bundle directly.
- **Azure:** operators are B2B guests, **PIM-eligible** for Platform Deployer on the
  dedicated subscription - never a standing active assignment. Activation requires MFA,
  carries a max duration, and can require approval. The CI service principal holds the role
  as a standing *active* assignment (it is the automation, not a human).

---

## Clean exit

You can wind an instance down completely and quickly:
1. Delete the dedicated project / subscription (removes all platform resources and the CI identity's scope at once).
2. Delete the federated credential / WIF binding (kills the pipeline's access immediately, even before teardown).
3. Remove operator accounts / the operator group and the app registrations.

No operator-held secret exists to leak, so revocation is complete by removing access, not
by rotating anything.

---

## Provenance

Grants above are traced to the standup code: `iac/bootstrap/gcp/bootstrap.sh` (the
`bind_project_role` calls + WIF) and `iac/bootstrap/azure/bootstrap.sh` (role bundle at
the `assign_role` calls; Entra app + federated credential), the landing zones
`iac/gcp/*.tf` and `iac/azure/*.tf`, and the gateway stacks.
