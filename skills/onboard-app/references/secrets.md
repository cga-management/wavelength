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

## Per-app gateway key (LLM apps)

If the app calls LLMs via the gateway, it must use a **per-app gateway key minted for the
app's slug** - never a shared or borrowed key. The operator mints the key in the gateway
for `<app>` and stores it as a Secret Manager secret exactly like any other API key (e.g.
`<app>-gateway-key`, referenced from `run.tf` as above). The per-app key is what makes the
app's AI spend attributable in the gateway's usage log - a shared key collapses every
app's model usage into one line and breaks per-app cost showback.

## Platform email (shared)

The platform provides a shared outbound-email capability (Resend) for notifications:
invites, digests, alerts. Unlike your own API keys, there is **nothing to seed and no
IAM step** - the key already exists as the `email-api-key` secret and the app runtime
SA can read it. The landing zone exposes everything you need as outputs:

| Output | Meaning |
|---|---|
| `email_api_key_secret_id` | Secret id of the shared key (SMTP password AND REST bearer token) |
| `email_smtp_host` | SMTP relay host |
| `email_smtp_port` | SMTP relay port (465, implicit TLS - set your client's secure flag) |
| `email_smtp_username` | SMTP username (for Resend, the literal string `resend`) |
| `email_from_domain` | The verified sending domain |

Consume it either way, same key:
- **SMTP**: standard mailer config from the outputs above, password via a
  `secret_key_ref` env (copy the commented block in `app-stack/run.tf`).
- **REST API / SDK**: inject the same secret as `RESEND_API_KEY` and use the Resend
  SDK or `POST https://api.resend.com/emails`.

**Sender convention (mandatory):** send only as `<app-slug>@<email_from_domain>`
(e.g. `myapp@...`). Do not invent other local parts; `platform@` is reserved for
platform-level sends. The slug-as-sender is what keeps mail attributable and
filterable per app.

**Budget:** the platform account is on Resend's free tier - 3,000 emails/month and a
hard 100/day cap, shared across ALL apps. This is for notifications, not bulk mail or
user-triggered fan-out. If your app needs real volume, raise it with the operator
first.

## What is already handled for you

- `DATABASE_URL` is provided as a secret env by your own stack's `database.tf`, created
  on first deploy - you never see or seed the value (see `shared-db-rls.md`).
- The IAP OAuth client secret and workforce identity are the platform's, injected by the
  `iap-lb` module - not app secrets.
