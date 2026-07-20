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
  `<PROJECT_ID>`. Where an example needs a concrete-looking value, use the blessed
  ones the gate knows: `my-project-123456`, `123456789012` (project/org number),
  `00000000-0000-0000-0000-000000000000` (UUID), `tfstate-<token>`,
  `user@example.com`.
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

1. **Format checks, always on**: em/en dash characters and entities in added lines;
   added non-example `*.auto.tfvars` files; added paths containing `.tfstate`,
   `.tfplan`, or `.terraform/`; `BEGIN ... PRIVATE KEY` blocks.
2. **Instance-value checks, always on**: added lines that look like real config
   rather than the template's placeholders - email addresses (other than
   `example.com` ones), GCP project ids and 12-digit project/org numbers, billing
   account ids, UUIDs, `tfstate-` bucket tokens, concrete workforce/workload pool
   ids, and hostnames outside the template's placeholder domains. It is on you to
   purge your instance's values before sending a PR; a PR that carries them will be
   rejected. These checks are heuristics: if the gate flags a genuine false
   positive, say so in the PR and the gate gets tuned.

A leak-gate failure names the offending file and line; fix it and push again.
