# Bootstrap - GCP

Same two-phase pattern as Azure (see [../README.md](../README.md)); not yet built.

- **Step -2 - [`ORG-SETUP.md`](ORG-SETUP.md)** (runbook): create the domain-managed
  Google Cloud **organization** for the client (Cloud Identity), break-glass admins,
  billing, and a baseline folder/policy skeleton. Run once per client, before anything
  below.
- **Step -1 - `create-project.sh`** (spec stub): provision the **project** (GCP's
  subscription-equivalent) under the org/folder and link billing.
- **Step 0 - bootstrap** (later): GCS bucket for state + Workload Identity Federation
  pool/provider + service account for CI, built alongside `iac/gcp/`.

**Status:** `ORG-SETUP.md` is a complete runbook; `create-project.sh` / `bootstrap.sh`
are spec/placeholder.
