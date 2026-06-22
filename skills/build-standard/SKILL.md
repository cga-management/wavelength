---
name: wavelength-build-standard
description: The "how we do it" standard for building apps under the Wavelength pipeline. Use whenever building or modifying an app intended to be shared or productionised. Defines repo structure, config and secret handling, model access via the gateway, IaC expectations, and what the Stage 2 promotion gate requires.
---

# Wavelength build standard

(Scaffold. Canonical, in-flow build standard. Mirrors the baseline the conformance gate enforces, in human-readable form. Keep the two in lockstep: if the gate checks it, this explains it.)

## The baseline
- Source in the central Git org, scaffolded from `wavelength-app-template`.
- Builds from a Dockerfile, proven in CI; no local Docker needed.
- Config from environment variables; `.env.example` committed, real `.env` git-ignored; secrets from the platform store, never code.
- Infrastructure as OpenTofu in `iac/`.
- Named and tagged per the convention below.

## Default to secure (fail closed)

Wherever a choice exists, the default state and every failure mode must be the secure
one - never exposed-without-protection. Deploy **private/internal first**; open access
(external ingress, public endpoints) only as a deliberate, separate step once the gate
(SSO/auth, policy, firewall) is confirmed in place. A half-finished or failed apply must
leave a resource **unreachable, not publicly ungated**. Example: create the Entra SSO
authConfig while the app is still internal, then flip to external - so a failed gate
apply leaves the app closed, not open.

## Naming and tagging (Azure; CAF-aligned)

Azure resource names are permanent - put only constant facts in the name, everything
else in tags.

**Naming.** `<type>-<workload>-<environment>` for scoped resources (e.g. `rg-wl-platform`,
`log-wl-platform`, `id-wl-platform`); `<type><workload><token>` for the globally-unique
ones - storage `st`, registry `cr`, Key Vault `kv` (e.g. `kv-wl-<token>`). The `<token>`
is a deterministic uniqueString-style hash of subscription + workload, derived identically
by bootstrap (`sha1sum`) and OpenTofu (`sha1()`), so it's never passed between them.

**Tagging** (lowercase keys):
- Mandatory, enforced by Azure Policy: `owner`, `env`, `costcenter`.
- Applied by the IaC: `workload`, `managedby=opentofu`, `region`, `expiry` (+ `repo` when set).
- Never put secrets or PII in tags - they're visible in cost reports, logs and exports.

## Model access
- Call models only through the platform gateway endpoint, never a vendor SDK with a direct key. This keeps the model swappable and spend auditable.

## Promotion to Stage 2 (Shared)
- Conformance workflow passes.
- PII assessment done and honest, because it is reconciled against the hosted data estate.

> TODO: expand into full guidance with worked examples.
