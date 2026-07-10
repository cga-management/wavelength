---
name: conformance
description: Conformance checks a Wavelength instance must pass before and during operation. Use when standing up a private copy, before the first push, or when diagnosing a failing conformance gate. Covers the must-be-private-repo guardrail and the baseline repo checks.
---

# Wavelength conformance

Checks every Wavelength instance must satisfy. The CI equivalents live in
`.github/workflows/private-repo-guard.yml` (runs on push/PR) and
`.github/workflows/conformance.yml` (the reusable gate apps call). Keep this and those
in lockstep.

## Must-be-private guardrail (run this first)

Your private copy holds your own org, project, billing and identity-provider identifiers.
A **public** repo leaks your cloud estate, so Wavelength must run from a **private** repo.
The only legitimate public repo is the canonical upstream template.

Check it locally before your first push (needs the GitHub CLI, authenticated):

```bash
slug=$(gh repo view --json nameWithOwner -q .nameWithOwner)
priv=$(gh repo view --json isPrivate -q .isPrivate)
if [ "$priv" = "true" ]; then
  echo "OK: $slug is private."
else
  echo "BLOCK: $slug is PUBLIC. Make it private before standing up Wavelength:"
  echo "  gh repo edit \"$slug\" --visibility private --accept-visibility-change-consequences"
fi
```

CI exemption for the canonical public template: set a repository variable
`WAVELENGTH_UPSTREAM_SLUG` to that repo's own `owner/name`. Private copies leave it unset
and must be private.

## Baseline repo checks (mirrors conformance.yml)

- `Dockerfile` present.
- `.env.example` present and a real `.env` is NOT committed.
- `iac/` exists and contains OpenTofu (`.tf`) files.
- A PII assessment exists (`pii-assessment.md` or `docs/pii-assessment.md`).
- Secret scan passes (gitleaks or equivalent).
