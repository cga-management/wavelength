# Contributing to Wavelength

Wavelength is a public template with private downstream instances. That shape decides
how contributions work: everything flows back to this repo as **issues and pull
requests**, and nothing else.

## How this repo relates to downstream instances

- **This repo is the source of truth.** Every instance is a **private copy** created per
  [QUICKSTART.md](QUICKSTART.md) (template copy or mirror, with this repo as the
  `upstream` remote). The private copy holds the operator's org, project, billing and
  identity-provider identifiers - which is exactly why it must stay private, and why
  this repo must never learn anything about it.
- **Instances are opaque to this repo.** No instance repo, hostname, org name or
  operator detail belongs here - not in code, not in docs, not in issue text. Instances
  pull template updates via `git fetch upstream && git merge upstream/main`; the
  template never pulls from an instance.
- **All feedback returns as issues or PRs against this repo.** There is no bulk
  tree-sync path from a private copy back to the template, and PRs that look like one
  (a whole-tree diff, a "sync from our instance" dump) will be closed. Extract the
  generic fix, strip the instance detail, and send that.

## Filing issues

The [existing issues](https://github.com/cga-management/wavelength/issues?q=is%3Aissue)
are the exemplar: field reports from a running instance, with the fix that was verified
there. A good issue has:

- **Title** = area prefix + the concrete symptom, e.g.
  `onboard-app: iap-identity.md omits the pyjwt dependency - Python apps 403 every request behind IAP`.
- **What happened and why** - the observed failure, then the root cause once you found
  it. Assumptions you could not verify are called out as assumptions.
- **The fix that worked** - the change you applied in your instance, generalized
  (placeholders, not your values). "We hit X, the cause was Y, this diff fixed it" is
  the ideal shape; a well-described failure without a fix is still welcome.

## Opening pull requests

- **One feature branch per change**, branched from `main`, deleted on merge. No
  long-lived personal branches, no umbrella branches carrying unrelated fixes.
- **Accurate titles.** The title states what the PR does to the template
  (`docs: ...`, `iac/gcp: ...`, `portal-gcp: ...`), not what happened in your instance.
- **Small and reviewable.** If a change spans several independent concerns, send
  several PRs.

## Acceptance criteria

Every PR is checked against these before merge (the leak gate below automates the
mechanical ones):

- **No instance identifiers.** No org names, GCP project ids or numbers, tenant ids,
  billing accounts, real email addresses, or real hostnames. Use the template's
  placeholders: `<your-org>`, `example.com`, `labs.example.com`, `<pool>`,
  `<PROJECT_ID>`.
- **No em or en dashes** - not the characters, not the HTML entities (`mdash`,
  `ndash`). Use a hyphen or a comma, or reword.
- **IaC is formatted and valid.** `tofu fmt -check -recursive` and `tofu validate`
  clean for any touched stack.
- **JavaScript parses.** `node --check` clean for any touched `.js` file.
- **No state, plans, or real tfvars.** `*.tfstate`, `*.tfplan`, `.terraform/` and
  non-`.example` `*.auto.tfvars` files never enter the template; per-instance config
  lives with the instance.

## The leak gate

Every PR runs [`.github/workflows/leak-gate.yml`](.github/workflows/leak-gate.yml),
which greps the PR diff in two layers:

1. **Generic checks, always on**: em/en dash characters and entities in added lines;
   added non-example `*.auto.tfvars` files; added paths containing `.tfstate`,
   `.tfplan`, or `.terraform/`; `BEGIN ... PRIVATE KEY` blocks.
2. **Private patterns, operator-supplied**: an extended regex held ONLY in the
   `LEAK_PATTERNS` repo secret (so the identifiers being guarded never appear in this
   public repo). When the secret is unset - as it is on forks - the step skips
   silently and only the generic checks apply.

A leak-gate failure names the offending file and line; fix it and push again.
