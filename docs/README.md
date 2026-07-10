# Design documents

Platform-level design docs (as opposed to the operator runbooks in
[QUICKSTART.md](../QUICKSTART.md) and the app-side guidance in
[skills/onboard-app/](../skills/onboard-app/SKILL.md)). Currently: the app registry /
portal pattern from RFC #19. [portal.md](portal.md) defines the portal as the platform's
control plane - the card-per-app registry, the role model and vetting gate, the data
model, and the deploy dispatch contract (extending the deploy workflow of RFC #17);
[cost-showback.md](cost-showback.md) defines per-app cost as three honestly-labelled
tiers (attributed, apportioned, AI spend) fed by an out-of-process collector; and
[usage-telemetry.md](usage-telemetry.md) defines aggregate-only usage metrics and the
usage-drives-archive loop.
