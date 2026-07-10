# Teardown - destroy a Wavelength instance on GCP

Standing up is [QUICKSTART.md](QUICKSTART.md); this is the reverse path. It exists
because `tofu destroy` is **not** a clean reverse of apply on GCP: two resources refuse
to delete until you flip a switch first, and two more block on asynchronous
producer-release lags that clear on their own if you retry. All four failures below were
hit on a real full teardown of a template-based instance.

## The shortcut: dedicated project

If the project is dedicated to this instance (the `create-project.sh` path) and you are
destroying everything, deleting the project replaces the whole landing-zone plus
app-stack teardown in one call:

```bash
gcloud projects delete <PROJECT_ID>
```

That removes every project-scoped resource: Cloud Run, Cloud SQL, the VPC, secrets, the
registry, DNS, the WIF pool and CI service account, and the state bucket (all of
bootstrap's project-scoped output). It does **not** remove anything that lives outside
the project:

- **Org-edge resources** ([iac/gcp-org/](iac/gcp-org/)): the workforce pool + provider
  and any org-level Cloud Armor policy. If the org edge lives in a different project
  from the one you are deleting, run step 3 below against it. Mind the blast radius:
  the org edge is shared, so only destroy it if this was the last instance using it.
- **The Entra app registrations** (if you used the worked example): delete them in your
  IdP.
- **DNS delegation at your apex**: remove the NS records pointing at the deleted zone.
- **The folder** (if `create-project.sh` put the project in one you no longer need).

So even the shortcut needs the org-edge destroy (step 3) and the out-of-project parts of
the bootstrap cleanup (step 5). If the project is shared with anything else, skip the
shortcut and run the full order.

## Full teardown order

The rule (learned the hard way): **destroy in reverse apply order, then poll-and-retry
the network layer** until GCP's asynchronous producer releases complete. Each step is a
`tofu destroy` in the stack's directory unless noted.

### 1. App stacks

For each onboarded app, `tofu destroy` in the app's `iac/` directory. The app stack
self-destroys its slice of the shared platform: its database, its database user, and its
connection-string secret (plus its Cloud Run service, LB chain and DNS record).

Ordering matters inside this step: after the one-time db-hardening SQL the app user owns
its database, and because the shared instance survives an app teardown the `DROP USER`
must actually succeed. The app-stack template
([skills/onboard-app/references/app-stack/database.tf](skills/onboard-app/references/app-stack/database.tf))
pins `depends_on` so the database is dropped before the user. If your app's stack
predates that fix and destroy fails with

```
role "<app>_app" cannot be dropped because some objects depend on it
```

add `depends_on = [google_sql_user.<name>]` to the `google_sql_database` resource and
re-run destroy.

### 2. gateway-gcp and outline-gcp

`tofu destroy` in [gateway-gcp/](gateway-gcp/) and [outline-gcp/](outline-gcp/). These
are apps too, just predating the app-stack template. Nothing special here; their Cloud
Run services must be gone before step 4 (the landing zone) can release the subnet.

### 3. Org edge (iac/gcp-org): disable the IAP OAuth client FIRST

A straight `tofu destroy` in [iac/gcp-org/](iac/gcp-org/) fails on the IAP OAuth client
credential:

```
Error 400: A credential can only be deleted if it is disabled.
```

The provider does not disable-then-delete, so do it by hand first. With the resource
names from [iac/gcp-org/iap-client.tf](iac/gcp-org/iap-client.tf) (client `wl-iap`,
credential `wl-iap-tf`):

```bash
gcloud iam oauth-clients credentials update wl-iap-tf \
  --oauth-client=wl-iap --location=global --project=<PROJECT_ID> --disabled
gcloud iam oauth-clients update wl-iap \
  --location=global --project=<PROJECT_ID> --disabled
```

Then `tofu destroy`. This removes the workforce pool + provider, the IAP client, and
Cloud Armor. Only do this if no other instance shares the org edge.

### 4. Landing zone (iac/gcp): expect two async lags, retry until clear

`tofu destroy` in [iac/gcp/](iac/gcp/). Expect it to fail partway, **twice, for reasons
that fix themselves**. Neither error means the destroy is broken; both mean a GCP
producer has not yet released its hold:

- **Serverless address reservations block the subnet.** Cloud Run Direct VPC egress
  creates `serverless.googleapis.com` address reservations on the apps subnet. They are
  not deletable by hand (`gcloud compute addresses delete` refuses; the serverless
  service holds them) and release asynchronously, minutes after the Cloud Run services
  are gone. Until then subnet deletion fails with:

  ```
  Subnetwork '.../snet-...' is already being used by '.../addresses/serverless-ipv4-...',
  resourceInUseByAnotherResource
  ```

- **The PSA connection lags Cloud SQL deletion.** The
  `google_service_networking_connection` will not delete until Cloud SQL's producer
  association releases, which lags past the instance deletion (`gcloud sql instances
  list` already returns nothing):

  ```
  Failed to delete connection; Producer services (e.g. CloudSQL ...) are still using this connection.
  ```

The fix for both is the same: wait and re-run. Either re-run `tofu destroy` by hand
every few minutes, or loop it:

```bash
until tofu destroy -auto-approve; do
  echo "producer release still pending; retrying in 3 minutes"
  sleep 180
done
```

Expect 5-20 minutes end to end. Only investigate if the same error is still repeating
after 30 minutes or so.

### 5. Bootstrap remnants (manual)

[iac/bootstrap/gcp/bootstrap.sh](iac/bootstrap/gcp/bootstrap.sh) created resources with
gcloud, not tofu, so no destroy covers them. If you are deleting the whole project, all
the project-scoped ones below go with it and you can skip to the last two bullets.
Otherwise, using bootstrap's default names (`WORKLOAD=wl`):

- **WIF provider + pool** (`github-actions` in pool `github`):

  ```bash
  gcloud iam workload-identity-pools providers delete github-actions \
    --workload-identity-pool=github --location=global --project=<PROJECT_ID>
  gcloud iam workload-identity-pools delete github \
    --location=global --project=<PROJECT_ID>
  ```

- **CI service account** (`wl-github-oidc`):

  ```bash
  gcloud iam service-accounts delete wl-github-oidc@<PROJECT_ID>.iam.gserviceaccount.com \
    --project=<PROJECT_ID>
  ```

- **State bucket** (`wl-tfstate-<token>`). It is versioned, so a plain bucket delete
  fails on the noncurrent state objects; remove everything (all versions) first:

  ```bash
  gcloud storage rm --recursive gs://wl-tfstate-<token>/
  gcloud storage buckets delete gs://wl-tfstate-<token>
  ```

  Deleting the state destroys the record of what tofu managed, so this is last: only
  after every stack above has destroyed clean.

- **The project** (`gcloud projects delete <PROJECT_ID>`) and, if `create-project.sh`
  created a folder you no longer need, the folder.
- **Outside GCP**: the Entra app registrations (or your IdP's equivalent), the NS
  delegation records at your DNS apex, and the `GCP_*` repo variables on your private
  copy.

## Why destroy is not reverse-apply on GCP

Several GCP services are "producers": they attach resources to your network on your
behalf and release them **asynchronously**, on their own schedule, after the consuming
resource is gone. Two bite here:

- Cloud SQL holds the service-networking (PSA) connection for minutes after the
  instance itself is deleted.
- Cloud Run Direct VPC egress holds serverless address reservations on the subnet for
  minutes after the services are deleted.

`tofu destroy` issues deletes in the right order but has no way to wait for a producer
release it cannot see, so it surfaces the holds as errors
(`resourceInUseByAnotherResource`, "Producer services ... are still using this
connection"). Those are **transient**, not real failures: the resource graph is fine,
the timing is not. Treat teardown as destroy-then-poll, re-running until the network
layer comes free, and reserve debugging for errors that survive the retry loop.
