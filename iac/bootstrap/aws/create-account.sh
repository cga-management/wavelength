#!/usr/bin/env bash
# Step -1 (AWS): provision the ACCOUNT the platform lives in.
#
# AWS's equivalent of an Azure subscription is an ACCOUNT - the billing, IAM and
# service boundary. It is created under AWS Organizations, ideally in a dedicated
# OU. Same intent as ../azure/create-subscription.sh; see ../README.md.
#
# Privileges (a billing/org-admin act - may be handed off; use --spec):
#   - run from the Organizations MANAGEMENT account
#   - organizations:CreateAccount (and organizations:MoveAccount to place it in an OU)
#
# Intended flow (implement alongside iac/aws/):
#   aws organizations create-account \
#     --email "$ACCOUNT_EMAIL" --account-name "$ACCOUNT_NAME"   # async
#   # poll until SUCCEEDED, capturing the new account id:
#   aws organizations describe-create-account-status \
#     --create-account-request-id "$REQUEST_ID"
#   # optionally move it into the Wavelength OU:
#   aws organizations move-account --account-id "$NEW_ID" \
#     --source-parent-id "$ROOT_ID" --destination-parent-id "$OU_ID"
#
# Then step 0 (bootstrap) for AWS creates:
#   - state backend: an S3 bucket (versioned) + a DynamoDB table for state locking
#   - CI identity: an IAM OIDC identity provider for
#     token.actions.githubusercontent.com, plus an IAM role whose trust policy is
#     scoped to repo:<github-org>/wavelength - the AWS equivalent of Azure's
#     Entra app + federated credential. No long-lived access keys.

set -euo pipefail
echo "AWS account creator (subscription-equivalent) - spec/placeholder."
echo "See the comments in this file and ../README.md. Implement with iac/aws/."
exit 1
