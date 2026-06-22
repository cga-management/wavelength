# Org setup - AWS (step -2, run once per instance)

The AWS analogue of [../gcp/ORG-SETUP.md](../gcp/ORG-SETUP.md): the prerequisite before
[`create-account.sh`](create-account.sh) and the Step 0 bootstrap. Establishes an **AWS
Organization** plus **IAM Identity Center** federated to your
Entra tenant, so users sign in with their existing credentials and the operator runs inside a
dedicated member **account**.

Human-run, console-plus-CLI. Generic: substitute your own values for every `<PLACEHOLDER>`.

## Placeholders

| Token | Meaning | Example |
|---|---|---|
| `<MGMT_ROOT_EMAIL>` | Root email for the Organizations management account | `aws-root@example.com` |
| `<ENTRA_TENANT>` | Your Entra/M365 tenant (IdP) | `example.com` tenant |
| `<HOME_REGION>` | IAM Identity Center home region | `eu-west-2` |
| `<ORG_ID>` / `<ROOT_ID>` | Organization id / root id (step 1) | `o-xxxx` / `r-xxxx` |

## How this differs from GCP (read first)

- **No domain verification.** AWS Organizations is not tied to a domain or a Cloud
  Identity equivalent. You create it from a management account whose only identity
  requirement is a root email. There is **no 50-user free cap** to reason about and
  **no per-user charge** for IAM Identity Center.
- **Identity Center is not fully syncless.** GCP Workforce Identity Federation stores no
  accounts. AWS **IAM Identity Center provisions user/group *records* via SCIM** from
  Entra. Those records are **credential-less** (authentication is delegated to Entra via
  SAML, no AWS-side passwords) and machine-synced, so it is far lighter than directory
  mirroring, but it is not literal-zero. The truly-syncless alternative is **ALB
  authenticate-oidc straight to Entra** (or a raw IAM SAML provider), at the cost of
  Identity Center's multi-account console/CLI experience.

## Ownership posture

Default trust model ([../../IDENTITY.md](../../IDENTITY.md)): your org / identity admin keeps
Organization / billing / tenant root and the operator runs Wavelength only inside a dedicated
member account. These may be the same person on your own tenant, or split when the privileged
role is held by a separate identity admin. Decide before starting. (Note: IDENTITY.md currently
specs Azure and GCP asks only; the AWS column is a gap to add - mirror G1/G2 with account-create
plus a CI role for the dedicated account.)

## Procedure

### 1. Create or confirm the Organization (management account)
From the management account (root email `<MGMT_ROOT_EMAIL>`, **MFA enforced on root**,
credentials in Vault):

```bash
aws organizations create-organization --feature-set ALL   # ALL = enables SCPs, not just billing
aws organizations describe-organization                   # capture <ORG_ID>
aws organizations list-roots                               # capture <ROOT_ID>
```

`--feature-set ALL` is required for **service control policies** (the guardrail analogue
of GCP org policies). The management account is break-glass only; run no workloads in it.

### 2. OU skeleton
```bash
aws organizations create-organizational-unit \
  --parent-id <ROOT_ID> --name wavelength
```

### 3. Enable IAM Identity Center
Console (`<HOME_REGION>`): IAM Identity Center -> Enable. Pick the home region
deliberately; it is not easily changed later. Enabling from the management account makes
it organization-wide.

### 4. Federate to your Entra tenant (external IdP)
1. In Identity Center -> Settings -> Identity source -> change to **External identity
   provider**. Download the AWS SSO **SAML service-provider metadata**.
2. In `<ENTRA_TENANT>`, add the **AWS IAM Identity Center** enterprise application
   (gallery app); upload/enter the AWS SAML metadata; assign the Entra groups that should
   reach AWS.
3. Enable **automatic provisioning (SCIM)** in Identity Center; put the SCIM endpoint +
   token into the Entra app's provisioning config. Entra then syncs the assigned
   users/groups as credential-less records.

Authentication is delegated to Entra; AWS holds no passwords.

### 5. Permission sets and assignments
- Create permission sets (e.g. an admin set for standup, scoped sets thereafter); each
  maps to an IAM role materialized in the target accounts.
- Assign **Entra-synced groups** (not individuals) to accounts with permission sets:
  ```bash
  aws sso-admin list-instances
  aws sso-admin create-permission-set --instance-arn <arn> --name WavelengthAdmin ...
  aws sso-admin create-account-assignment --instance-arn <arn> \
    --permission-set-arn <ps-arn> --principal-type GROUP --principal-id <group-id> \
    --target-type AWS_ACCOUNT --target-id <account-id>
  ```

### 6. Dedicated member account + CI
- [`create-account.sh`](create-account.sh) - create the dedicated Wavelength member
  account under the `wavelength` OU and link billing.
- Step 0 bootstrap (later) - S3 + DynamoDB lock table for state, an **IAM OIDC provider**
  for GitHub Actions, and a CI role, built alongside `iac/aws/`.

### 7. Human SSO edge (later, with the gateway)
- Cheapest analogue of IAP: **ALB `authenticate-oidc`** pointed at the Entra tenant (free
  ALB feature; pay only for the ALB) on a custom domain with an **ACM** cert.
- Premium zero-trust analogue: **AWS Verified Access** (paid per app + data processing;
  adds device trust + Cedar policy). Use only if that posture is required.

## Verification checklist
- `aws organizations describe-organization` shows `FeatureSet: ALL` and `<ORG_ID>`.
- IAM Identity Center identity source is the external Entra IdP; a test Entra user signs
  in through the AWS access portal.
- SCIM has synced the assigned groups (visible under Identity Center -> Groups).
- A permission set is assigned to at least one account for a federated group.
- Root user of the management account has MFA; credentials in Vault.

## Gotchas
- **`--feature-set ALL`** is needed for SCPs; an org created billing-only must be upgraded
  (all members must accept the change).
- **Identity Center home region is sticky** - choose `<HOME_REGION>` carefully.
- **SCIM provisions records, not credentials** - lifecycle still lives in Entra; deprovision
  there. Don't confuse the synced records with duplicate logins.
- **Post-cutoff items to confirm live:** the Entra gallery-app + SCIM steps and Verified
  Access pricing, both of which evolve.
