# GCP landing zone (OpenTofu)

The GCP sibling of [`../azure/`](../azure/), mapping the same intents onto GCP:
Cloud Run for compute, Secret Manager for secrets, Artifact Registry for images,
Cloud SQL for Postgres, Cloud Logging retention, and (optional) Organization Policy
guardrails. Same parameterised shape: `providers.tf`, `backend.tf` (GCS),
`variables.tf`, `main.tf`, plus per-concern files.

**Status:** built for the multi-cloud testing round (mirrors the live Azure platform).

## Azure -> GCP mapping

| Azure (iac/azure/) | GCP (here) |
|---|---|
| Resource group | the **project** (boundary; created in step -1) |
| Tags | **labels** (lowercase `[a-z0-9_-]`, slashes sanitised) |
| VNet + delegated subnets + private DNS | `google_compute_network` + `snet-*` + Private Service Access |
| Log Analytics workspace | Cloud Logging `_Default` bucket retention |
| Key Vault (RBAC) | Secret Manager (IAM `secretAccessor`) |
| Container Registry (admin off) | Artifact Registry (pull via SA) |
| User-assigned managed identity | `google_service_account` (Cloud Run runs as it) |
| Postgres Flexible Server (private) | Cloud SQL (private IP via PSA) |
| Azure Policy (regions/tags/deny-public-DB) | Org Policy (`enable_org_policies`, off by default) |

## Stand-up

```bash
# Step 0 (once): state bucket + APIs + Workload Identity Federation for CI.
PROJECT_ID=<project> ../bootstrap/gcp/bootstrap.sh

# Landing zone.
export GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token)"   # or use ADC
tofu init \
  -backend-config="bucket=wl-tfstate-<token>" \
  -backend-config="prefix=gcp-landing-zone"
tofu apply

# Supply the operator secret (value never enters tofu state):
echo -n "<ANTHROPIC_API_KEY>" | gcloud secrets versions add anthropic-api-key \
  --project=<project> --data-file=-
```

Then build the Bifrost image into Artifact Registry and apply
[`../../gateway-gcp/`](../../gateway-gcp/).

## Billing export (one-time, manual)

GCP's BigQuery billing export is a Billing-account setting that Terraform cannot
create - enable it by hand, once, at platform standup:

1. Create or choose a BigQuery dataset in the platform project (the landing zone's
   telemetry dataset from `telemetry.tf` works, or make a dedicated one).
2. In the console: **Billing -> Billing export -> BigQuery export**, enable
   **Detailed usage cost** to that dataset.

Do this NOW, not when cost reporting is first wanted: the export accumulates only
from the day it is enabled, and Cloud Run cost rows carry the per-app `app` label
only after a labelled revision is live. Data not captured is lost forever.

## Notes

- **pgvector** is not an instance flag on Cloud SQL; if an app needs it, enable it per
  app database with `CREATE EXTENSION vector` (Bifrost does not need it).
- **Org policies** need `roles/orgpolicy.policyAdmin` and are partly org-scope only;
  left off for this standalone project. Private-IP-only Cloud SQL gives the
  deny-public-DB posture regardless.
- **Label hygiene**: GCP has no "require a label" constraint; enforced by convention
  (every resource carries `local.labels`).
