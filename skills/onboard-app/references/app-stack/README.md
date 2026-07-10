# App OpenTofu stack template

Copy this whole directory into your app repo as `iac/` and adapt it. It is a faithful,
minimal version of the platform's reference app stack (`outline-gcp/`), reduced to what a
custom app that **inherits IAP identity** needs: a scale-to-zero, internal-ingress Cloud Run
service behind one IAP-gated LB route, reading the shared DB secret and its API-key secrets.

## Rename

Everything uses the placeholder slug **`myapp`**. Replace `myapp` with your app's slug
throughout (filenames stay; edit contents). Keep it short, lowercase, `[a-z0-9-]`.
This includes the `app = "myapp"` label in `run.tf` (service AND template) - the billing
export attributes per-app cost by that label, so a wrong slug means misattributed spend.

## Files

- `backend.tf` - partial GCS backend; bucket + `prefix = gcp-myapp` supplied at init.
- `providers.tf` - google + google-beta (~>6.0, beta needed for IAP settings) + random.
- `main.tf` - reads landing-zone (`lz`) and org-edge (`edge`) remote state; image locals.
- `variables.tf` - inputs; fill via `instance.auto.tfvars` (copy the `.example`).
- `database.tf` - self-provisions the app's DB slice on FIRST deploy: the `myapp` database
  on the shared instance, a dedicated `myapp_app` database user with a generated password,
  and the `myapp-database-url` secret holding the DSN. Instance name + private IP come
  from `lz` remote state. No operator step. (A one-time hardening SQL exists for the
  operator - `../db-hardening.md` - because API-created users share `cloudsqlsuperuser`;
  the app works without it.)
- `run.tf` - the Cloud Run service (min=0, internal ingress, DB + secret envs).
- `lb.tf` - the IAP load balancer via the `iap-lb` module (one IAP-gated route).
- `dns.tf` - one A record in the shared Cloud DNS zone.
- `outputs.tf` - LB IP, hostname, and **computed_iap_audience** (the exact IAP audience the
  module builds) for the two-phase apply.
- `instance.auto.tfvars.example` - copy to `instance.auto.tfvars` (gitignored) and fill.

## The `iap-lb` module (INCLUDED - nothing to download)

`lb.tf` uses `source = "./modules/iap-lb"`, and the module ships WITH this template at
`modules/iap-lb/` (three files: `main.tf`, `variables.tf`, `outputs.tf`, each carrying a
vendored-from provenance header). Copying this whole directory into your app's `iac/`
brings it along - just make sure `iac/modules/iap-lb/` is COMMITTED: the platform's deploy
workflow builds from YOUR repo, and `tofu init` fails without it (this has happened).

Do not edit the module files. If the platform module has evolved since this skill was
packaged (compare the provenance header's commit), re-sync from the platform repo - anyone
with read access can:

```bash
for f in main.tf variables.tf outputs.tf; do
  gh api repos/<your-platform-repo>/contents/iac/modules/iap-lb/$f \
    --jq .content | base64 -d > iac/modules/iap-lb/$f
done
```

No access / no `gh`? Ask the platform operator for the three files - the version bundled
here still works in the meantime.

## Prerequisites (OPERATOR does these first)

1. Give you: `project_id`, `region`, `workload`, `environment`, `state_bucket`, the DNS zone
   details, a hostname (`myapp.<subdomain>`), and the project NUMBER (for the IAP audience).

There is NO DB carve-out prerequisite: `database.tf` creates the database, the app user,
and the connection-string secret on the first apply. The only DB-related operator action
is the one-time hardening SQL in `../db-hardening.md`, run at leisure AFTER first deploy.

## TLS

TLS is instant via the platform wildcard: `lb.tf` passes the landing zone's Certificate
Manager certificate map (`certificate_map = try(local.lz.certificate_map_id, null)`) to the
`iap-lb` module, so the LB serves the standing `*.<subdomain>` wildcard cert the moment the
forwarding rule exists - no per-hostname provisioning wait. If the landing zone predates the
wildcard (no `certificate_map_id` output), the `try()` falls back to null and the module
provisions a classic per-host Google-managed cert instead, which takes 15-60 min on the
first deploy. No app-side action needed in either case.

## Applying this stack is the PLATFORM's job, not the app side

You (the app agent) commit these `.tf` files + the `.example` tfvars and push. You do NOT
run `tofu`. The platform's `deploy-app` workflow (in the Wavelength repo) supplies the real
values at deploy time (`project_id`, `region`, `state_bucket`, `app_hostname`,
`app_owner_email`, `image_tag`) via `-var`, so **do not commit a filled `instance.auto.tfvars`**
- the `.example` is only documentation of the inputs.

The deploy is **two-phase** because the IAP audience embeds the LB backend id, which does not
exist until the LB is created (and the LB depends on the Cloud Run service, so it cannot be
injected in one pass). The workflow handles this automatically: apply once, read the
`computed_iap_audience` output, set `iap_audience`, apply again. Until phase 2, the app fails
closed - fine, since it is not reachable until DNS + the managed cert are ready anyway (15-60 min).

See `../deploy.md` for the full app-side vs platform-side split.
