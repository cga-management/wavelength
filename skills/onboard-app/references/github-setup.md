# Step 0: GitHub + the private repo (do this first)

Many users starting this have their app only on their laptop - no GitHub repo at all, or a
personal/public one. The platform requires the app to live in a **private repo inside the
organisation's GitHub org** (the private-repo guard fails otherwise, and CI/conformance run
from there). Walk the user through this before any code or infra changes.

Work through it in order; skip a step only if it is already true.

## 1. A GitHub account

- If the user has no GitHub account: have them create one at github.com and sign in.
- Install/authenticate the GitHub CLI so you (the agent) can act on their behalf:
  ```bash
  gh auth login          # choose GitHub.com, HTTPS, authenticate in browser
  gh auth status         # confirm signed in
  ```

## 2. Access to the organisation

The app must end up in your GitHub organisation (`<your-org>`).

- Check whether the user is already a member:
  ```bash
  gh api user/memberships/orgs/<your-org> 2>/dev/null | grep -q '"state": *"active"' \
    && echo "member" || echo "NOT a member - request an invite"
  ```
- If not a member: **a GitHub org owner must invite them** (Org -> People -> Invite member).
  This is a human/OPERATOR step - the user cannot self-join. Confirm they can create repos
  in the org (org settings may restrict repo creation to certain roles); if not, the owner
  either grants that or creates the empty repo for them.

## 3. Get the app into the org as a PRIVATE repo

Pick the case that matches the user's starting point:

**A. No repo yet (local code only).** From the app directory:
```bash
git init            # if not already a git repo
git add -A && git commit -m "initial import"   # ensure no secrets/.env are staged first!
gh repo create <your-org>/<app> --private --source=. --remote=origin --push
```

**B. Repo exists under their personal account.** Move it into the org and make it private:
```bash
# Transfer (keeps history, issues, stars). Requires create rights in the org.
gh api repos/<user>/<app>/transfer -f new_owner=<your-org>
# then ensure private:
gh repo edit <your-org>/<app> --visibility private --accept-visibility-change-consequences
```
If transfer is not permitted, create an empty private org repo and push:
```bash
gh repo create <your-org>/<app> --private
git remote add origin https://github.com/<your-org>/<app>.git   # or set-url
git push -u origin HEAD
```

**C. Repo already in the org but public.** Just flip it private:
```bash
gh repo edit <your-org>/<app> --visibility private --accept-visibility-change-consequences
```

## 4. Normalize the branch to `main` (the platform assumes it)

The portal card's ref and the deploy workflow default to `main`. If the local repo was
initialized with `master` (older git defaults), rename it now - a card pointing at `main`
while the repo only has `master` fails the deploy at checkout:

```bash
git branch -m master main 2>/dev/null || true   # no-op if already main
git push -u origin main
gh repo edit <your-org>/<app> --default-branch main
```

## 5. Confirm it is private (the guard depends on this)

```bash
gh repo view <your-org>/<app> --json isPrivate -q .isPrivate   # must print: true
```

## 6. Hygiene before the first push

- Ensure a `.gitignore` excludes `.env`, `*.tfvars` (keep `*.tfvars.example`), and any local
  secret files. **Never commit real secrets** - if any were already committed, rotate them
  and scrub history before continuing.
- Commit a `.env.example` with placeholder values (conformance checks for it).

## Result

The app is a **private repo in the `<your-org>` org**, cloned locally, ready for the
onboarding steps (containerise, identity, DB, secrets, IaC, deploy). The org name and any
invite/permission actions are the OPERATOR's to confirm.
