# API keys and secrets: GCP Secret Manager

Local apps usually keep API keys (OpenAI, Stripe, etc.) in a `.env`. On the platform,
**secrets live in Google Secret Manager** and are injected into Cloud Run as env vars. The
app code reads the same env var name it always did - only the source changes.

## Two rules

1. **Never bake keys into the image, the repo, or `.env`.** Commit only `.env.example` with
   placeholder values; keep the real `.env` gitignored. No secret ever enters git or a
   container layer.
2. **Use DIFFERENT keys for the deployed copy than the local app.** The deployed copy is a
   separate environment reachable by other users - give it its own provider API keys so you
   can rotate or revoke them independently of the developer's local keys, and so local
   experimentation cannot burn or leak the hosted app's credentials.

## How to wire a secret (app side vs operator)

You (the app side) do NOT run `gcloud` and do NOT hold the deployed key in the repo. You:
- **declare the need + reference it** in the stack (step 2 below), and
- **hand the operator the deployed-copy key value** through a secure channel (not a commit).

The **operator** creates the Secret Manager secret with that value (the app runtime SA
already has `roles/secretmanager.secretAccessor`, so no extra IAM):
```bash
# OPERATOR, once, with the value you supplied out of band:
printf '%s' "$THE_NEW_DEPLOYED_KEY" | \
  gcloud secrets create ‹app›-openai-api-key --data-file=- --project=<PROJECT_ID>
# rotate later:  gcloud secrets versions add ‹app›-openai-api-key --data-file=-
```
Keeping the value out of tofu state and out of git is deliberate - the secret exists only in
Secret Manager.

**You reference it as a Cloud Run secret env var** in the app stack (`run.tf`):
   ```hcl
   env {
     name = "OPENAI_API_KEY"           # same name the app already reads
     value_source {
       secret_key_ref {
         secret  = "‹app›-openai-api-key"
         version = "latest"
       }
     }
   }
   ```
**App code is unchanged** - it still does `os.environ["OPENAI_API_KEY"]`. Locally that comes
from `.env`; deployed it comes from Secret Manager via Cloud Run.

## Model access note

If the app calls an LLM, the platform's preference is to route model calls through the
shared **gateway** endpoint rather than a direct vendor SDK + key, so spend is auditable and
the model is swappable (the platform's build standard covers this). If the gateway is available, point
the app's base URL at it and use a gateway virtual key (still stored in Secret Manager). If
not, a direct provider key in Secret Manager (with a deployed-only key per rule 2) is the
interim.

## What is already handled for you

- `DATABASE_URL` is provided as a secret env by your own stack's `database.tf`, created
  on first deploy - you never see or seed the value (see `shared-db-rls.md`).
- The IAP OAuth client secret and workforce identity are the platform's, injected by the
  `iap-lb` module - not app secrets.
