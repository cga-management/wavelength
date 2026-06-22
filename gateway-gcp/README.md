# Model gateway on GCP (OpenTofu)

The GCP sibling of [`../gateway/`](../gateway/): Bifrost on Cloud Run, fronted by an
OIDC-gated oauth2-proxy. Reads the platform foundation from the
[`../iac/gcp/`](../iac/gcp/) landing-zone state.

oauth2-proxy is a generic OIDC client; **Entra / M365 ships as the worked example** (this
stack can auto-create the Entra app registration). For another OIDC IdP (e.g. Auth0), set
`create_entra_app_registration = false` and supply the `oidc_*` inputs.

The Bifrost **image is reused unchanged** from [`../gateway/bifrost/`](../gateway/bifrost/)
- only the build target (Artifact Registry) and the secret source (Secret Manager)
differ from Azure.

## Edge model (three-ring doctrine on GCP)

- **Ring 1** - `wl-gwui-*` oauth2-proxy, public ingress, scale-to-zero, OIDC-gated.
- **Ring 2** - `wl-bifrost-*`, internal ingress only, warm (min 1). Reached by the
  proxy over the VPC (Direct VPC egress = ALL_TRAFFIC on the proxy).
- **Ring 3** - private Cloud SQL (landing zone), no public IP.

Two things worth calling out vs Azure:
- **Host header**: `OAUTH2_PROXY_PASS_HOST_HEADER=false` - the SAME as Azure, and for
  the same reason. Cloud Run's frontend also routes by the Host header, so the proxy
  must send the upstream (Bifrost) hostname. Leaving it `true` makes the proxy forward
  its own hostname, Cloud Run routes the upstream call back to the proxy, and the loop
  is shed as 429 "Rate exceeded." (Bifrost never sees the request). Do not set `true`.
- **Wake**: Bifrost is warm for operational reasons (shared-service cold start), not
  a wake defect - Cloud Run internal ingress does wake a service, unlike the Azure
  Container Apps internal edge.

The proxy and Bifrost also run with scaling headroom (proxy min 1/max 4, Bifrost min
1/max 8): Cloud Run returns a hard 429 when a request burst outpaces a low instance
ceiling, where Azure Container Apps would queue.

## Stand-up (two-phase, because Cloud Run's URL is not known until deploy)

```bash
export GOOGLE_OAUTH_ACCESS_TOKEN="$(gcloud auth print-access-token)"   # google provider
az login                                                              # azuread provider (Entra example only)

tofu init \
  -backend-config="bucket=wl-tfstate-<token>" \
  -backend-config="prefix=gcp-gateway"

# Phase 1 - deploy services; the IdP app gets a placeholder redirect URI.
tofu apply

# Phase 2 - feed the proxy URL back so the IdP redirect URI matches the callback.
tofu apply -var "oauth2_proxy_url=$(tofu output -raw oauth2_proxy_url)"
```

`instance.auto.tfvars` (gitignored; copy `instance.auto.tfvars.example`) supplies
`project_id`, `state_bucket`, and the IdP inputs (`entra_tenant_id` for the Entra example,
or `oidc_*` for another IdP).

## Notes

- The Anthropic key must be present in Secret Manager (`anthropic-api-key`, created
  empty by the landing zone) before Bifrost can serve completions.
- Round-1 posture: Bifrost is `allUsers` invoker (network protection is internal
  ingress + VPC origin; app auth is Bifrost's virtual-key enforcement). Harden to a
  dedicated invoker SA + ID token later.
