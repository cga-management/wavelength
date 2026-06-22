# Bootstrap - AWS

Same two-phase pattern as Azure (see [../README.md](../README.md)); not yet built.

- **Step -2 - [`ORG-SETUP.md`](ORG-SETUP.md)** (runbook): create the **AWS Organization**
  and federate **IAM Identity Center** to your Entra tenant. Run
  once per instance, before anything below. AWS analogue of [../gcp/ORG-SETUP.md](../gcp/ORG-SETUP.md).
- **Step -1 - `create-account.sh`** (spec stub): provision the **account** (AWS's
  subscription-equivalent) via Organizations, in a dedicated OU.
- **Step 0 - bootstrap** (later): S3 bucket + DynamoDB lock table for state + an IAM
  OIDC provider and role for CI, built alongside `iac/aws/`.

**Status:** `ORG-SETUP.md` is a complete runbook; `create-account.sh` is spec/placeholder.
