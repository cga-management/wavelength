---
name: pii-assessment
description: Produces the PII assessment required to promote an app to the Wavelength shared stage. Use when preparing an app for Stage 2 or when its data handling changes. Inventories what data the app consumes, accesses, stores and sends onward from the code and config, then prompts for the human judgments a scan cannot supply.
---

# Wavelength PII assessment

(Scaffold. Generates the data index and the tracked issue; prompts the developer for what only a human knows.)

## What the skill enumerates (from code and config)
- Data consumed, accessed, stored, and sent onward.
- Egress destinations and third-party APIs.
- Connected sources (including Microsoft Graph scopes) and what gets logged.

## What it asks the developer (a scan cannot)
- Purpose for each data element.
- Lawful basis.
- Retention intent (feeds the per-app archive retention).
- Consent mechanism, where relevant.

## Output
- A structured report committed to the repo (`pii-assessment.md`).
- A tracked issue on the central board.

> The platform reconciles this declaration against the observed estate. The signal that matters is the delta, so an honest assessment is the only one that survives.
> TODO: define the report schema and issue template; decide process-gate vs risk-gate behaviour.
