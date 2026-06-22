# Bootstrap - the per-cloud "prepare a clean home" pattern

Before any landing zone (`iac/<cloud>/`) can deploy, two things must exist that
IaC itself can't create from nothing. This is the same two-phase pattern on every
cloud; only the resource names differ.

| Phase | What | Why it can't be IaC | Privilege |
|-------|------|---------------------|-----------|
| **Step -1 - create the tenancy/billing container** | Azure *subscription* · GCP *project* · AWS *account* | It's the boundary everything else is created *inside*; nothing to deploy into yet | **Billing/org admin** (distinct from resource admin) |
| **Step 0 - bootstrap** | Remote state backend + CI's OIDC identity | State has nowhere to live; CI has no identity to authenticate as | **Resource admin** (Owner) on the container from step -1 |

After step 0, every later `tofu` run uses the remote backend and OIDC, from CI or
locally, with **no stored secrets**.

## Why its own container (subscription / project / account)?

The container is the **billing + access + policy boundary**. Giving Wavelength its
own means: spend is isolated and attributable; a mistake or compromise in its CI
identity can't reach anything else in the tenant; and the landing-zone guardrails
(region lock, required tags, deny-public-DB) apply to it without touching the rest
of the estate. Identity stays shared - the Entra tenant / GCP org / AWS org sits
*above* the container - so isolating it doesn't fragment users or app registrations.

## Step -1 is also a spec

Creating the container is a **billing-scoped** act, a different privilege from the
resource-admin role step 0 needs. Whoever runs Wavelength may not hold it. So each
`create-*` script runs where you *do* hold billing rights **and** has a `--spec`
mode that prints exactly what to provision and changes nothing - hand that to a
billing admin and it doubles as the request. It encodes the intended end state even when
someone else has to do it.

## Layout

```
bootstrap/
  azure/  create-subscription.sh  (step -1)   bootstrap.sh (step 0)   <- built & proven
  gcp/    create-project.sh       (step -1)   [bootstrap.sh later]    <- spec stub
  aws/    create-account.sh       (step -1)   [bootstrap.sh later]    <- spec stub
```

Azure is implemented and validated first; GCP and AWS carry the same-shaped step -1
spec stub and gain their step-0 bootstrap when `iac/gcp/` and `iac/aws/` are built.

## Cross-cloud equivalents

| Concept | Azure | GCP | AWS |
|---------|-------|-----|-----|
| Tenancy/billing container | Subscription | Project | Account |
| Sits under | Management group | Org / Folder | Org / OU |
| Remote state backend | Storage Account + container | GCS bucket | S3 bucket + DynamoDB lock |
| CI identity (no secrets) | Entra app + federated credential | Workload Identity Federation + service account | IAM OIDC provider + role |
| "Register providers" | `az provider register` | `gcloud services enable` | (none - services are on by default) |
