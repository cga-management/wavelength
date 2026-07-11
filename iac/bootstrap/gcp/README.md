# Bootstrap - GCP

Same two-phase pattern as every cloud (see [../README.md](../README.md)); built and
proven on live instances.

- **Step -2 - [`ORG-SETUP.md`](ORG-SETUP.md)** (runbook): create the domain-managed
  Google Cloud **organization** (Cloud Identity), break-glass admins, billing, and a
  baseline folder/policy skeleton. Run once per org, before anything below.
- **Step -1 - `create-project.sh`**: provision the **project** (GCP's
  subscription-equivalent) under the org/folder and link billing. Has a `--spec` mode
  to hand the request to a billing admin. Run once by a human.
- **Step 0 - `bootstrap.sh`**: enable the APIs, create the GCS state bucket, and the
  Workload Identity Federation pool/provider + service account CI authenticates as.
  Run once by a human with admin on the project from step -1; prints the `GCP_*`
  repo variables to set. Idempotent.

The ordered end-to-end runbook (including the org edge, landing zone and the first
app) is [STANDUP-template.md](STANDUP-template.md).
