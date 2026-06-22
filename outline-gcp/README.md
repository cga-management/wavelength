# Outline wiki (GCP)

Outline (`outlinewiki/outline`) deployed on Cloud Run as the first app behind the
shared IAP perimeter - and the reference pattern for putting an app on the perimeter.

## Architecture

- **Cloud Run, 2 containers**: Outline (port 3000) + a Redis sidecar (`localhost:6379`).
  Ingress is `INTERNAL_LOAD_BALANCER` - reachable only through the LB.
- **Shared Postgres**: the `outline` database on the landing-zone Cloud SQL instance.
- **File storage**: a private GCS bucket mounted into the container via **gcsfuse**
  (used as Outline `FILE_STORAGE=local`). The org enforces
  `iam.disableServiceAccountKeyCreation`, which blocks the HMAC key the S3-interop path
  would need; gcsfuse authenticates as the app SA via IAM instead.
- **SSO**: Outline's own OIDC login (Entra worked example, app `wl-outline-oidc-gcp`; set
  `create_entra_app_registration = false` + the `oidc_*` inputs for another IdP).
- **Perimeter**: the shared external HTTPS LB + IAP (workforce / your OIDC IdP) from
  [../iac/gcp-org/](../iac/gcp-org/), via the [../iac/modules/iap-lb/](../iac/modules/iap-lb/) module.
  - `var.outline_hostname` (e.g. `outline.labs.example.com`) - humans, **IAP-gated**, Cloud Armor `sso-default`.
  - `var.mcp_hostname` (e.g. `outline-mcp.labs.example.com`) - Anthropic MCP, **IAP-bypassed**,
    Cloud Armor `anthropic-only` (IP allowlist), authenticated by an Outline API token.

One interactive login: users hit IAP (one IdP sign-in via the workforce pool), then
Outline's own OIDC rides the same IdP SSO session silently.

## Prerequisites

1. Landing zone applied (`../iac/gcp/`) - provides network, Cloud SQL, the `outline`
   DB + `outline-database-url` secret, Artifact Registry, the app service account.
2. Org edge applied (`../iac/gcp-org/`) - workforce WIF + IAP OAuth client + Cloud
   Armor policies. Its outputs are read from state (`gcp-org-edge`).
3. Images mirrored into Artifact Registry (Cloud Run pulls from `*.docker.pkg.dev`):
   ```bash
   AR=$(cd ../iac/gcp && tofu output -raw artifact_registry_repo)   # <region>-docker.pkg.dev/<project>/<repo>
   # Outline
   docker pull outlinewiki/outline:<version>
   docker tag  outlinewiki/outline:<version> ${AR}/outline:<version>
   docker push ${AR}/outline:<version>
   # Redis
   docker pull redis:7-alpine
   docker tag  redis:7-alpine ${AR}/redis:7-alpine
   docker push ${AR}/redis:7-alpine
   ```
   Set `outline_image_tag` / `redis_image_tag` accordingly.

## Deploy

```bash
tofu init \
  -backend-config="bucket=wl-tfstate-<token>" \
  -backend-config="prefix=gcp-outline"

tofu apply \
  -var project_id=<PROJECT_ID> \
  -var entra_tenant_id=<TENANT_ID> \
  -var outline_image_tag=<version>
```

Instance-specific values live in a gitignored `instance.auto.tfvars` (project id, tenant
id, hostnames, image tags); copy `instance.auto.tfvars.example` to start.

### DNS + cert

After the first apply, read `lb_ip_address` and create A records (under your delegated
app subdomain):

```
<outline_hostname>      A   <lb_ip_address>
<mcp_hostname>          A   <lb_ip_address>
```

The Google-managed cert provisions automatically once both names resolve to the IP
(can take 15-60 min). Until then HTTPS will fail - this is expected.

## Notes / gotchas

- **DB migrations** run on every revision start (`yarn db:migrate --env=production`,
  idempotent) before `yarn start`. `PGSSLMODE=no-verify` because Cloud SQL enforces
  SSL but presents a cert the node pg client won't chain-verify over the private IP.
- **Single instance**: Redis is a per-instance sidecar (non-shared pub-sub), so
  `min`/`max` are pinned to 1. Going multi-instance requires Memorystore.
- **IAP on the LB only** - never also on the Cloud Run service (Google warns against
  double-enabling); the service stays `INTERNAL_LOAD_BALANCER` with no public invoker,
  which also avoids the org's `allUsers` domain-restricted-sharing block.
- **MCP connector**: point an Anthropic "Outline Native" connector at
  `https://<mcp_hostname>` with an Outline API token (Outline UI -> Settings ->
  API tokens).
