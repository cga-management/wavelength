# Cloud-agnostic modules

Shared building blocks consumed by the per-cloud landing zones. A module here expresses an intent (for example "a secret store", "a scale-to-zero container app", "an observability workspace") and each cloud's root wires it to that cloud's concrete resources.

Keep cloud-specific resource types out of here; they belong in `azure/`, `gcp/`, `aws/`.

**Status:** placeholder. Extract modules as patterns repeat across clouds, not before - Azure first.
