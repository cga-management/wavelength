# GCP landing zone. The shared, parameterised baseline every Wavelength app stage
# deploys into - the sibling of iac/azure/, mapping the same intents onto GCP
# (Cloud Run, Secret Manager, Artifact Registry, Cloud SQL, a logging sink and
# org-policy guardrails). Resources are split by concern across the sibling .tf
# files (network, database, secrets, registry, identity, monitoring, policy); this
# file holds the naming token, the standard label set, and belt-and-braces API
# enablement.
#
# There is no resource-group equivalent on GCP: the PROJECT is the boundary, and it
# is created in step -1 (bootstrap/gcp/create-project.sh). Scoped names follow
# <type>-<workload>-<environment>; the few globally/project-unique ones carry the
# instance token.

locals {
  # Token for unique names. Mirrors Azure's uniqueString(): a deterministic hash of
  # an already-unique seed (the project id). bootstrap.sh derives the identical value
  # via `sha1sum`, so the state bucket and these resources share one token with
  # nothing passed between them.
  instance_id = substr(sha1("${var.project_id}-${var.workload}"), 0, 8)

  # Standard label set. GCP labels must be lowercase [a-z0-9_-] with no dots or
  # slashes, so the repo value is sanitised. owner/env/costcenter mirror the Azure
  # tag set (enforced there by policy; here applied for cost/ops/lifecycle visibility).
  labels = merge(
    {
      owner      = var.owner
      env        = var.environment
      costcenter = var.cost_center
      workload   = var.workload
      managedby  = "opentofu"
      region     = var.region
      expiry     = var.expiry
    },
    var.repo != "" ? { repo = replace(var.repo, "/", "_") } : {},
    var.labels,
  )
}

# Belt-and-braces API enablement (bootstrap.sh already enabled these; declaring them
# here keeps the landing zone self-describing and re-creatable in a fresh project).
# disable_on_destroy = false so a teardown never yanks APIs out from under siblings.
resource "google_project_service" "apis" {
  for_each = toset([
    "run.googleapis.com",
    "sqladmin.googleapis.com",
    "secretmanager.googleapis.com",
    "artifactregistry.googleapis.com",
    "vpcaccess.googleapis.com",
    "servicenetworking.googleapis.com",
    "compute.googleapis.com",
    "logging.googleapis.com",
    "orgpolicy.googleapis.com",
    "iap.googleapis.com",
    "dns.googleapis.com",
  ])
  project            = var.project_id
  service            = each.key
  disable_on_destroy = false
}
