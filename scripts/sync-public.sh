#!/usr/bin/env bash
# Promote the public Wavelength blueprint from this (private) repo into a checkout of the
# public repo. The public repo is a SEPARATE git repository with its own history - this
# script only copies the file tree; it never touches git history. Build improvements here
# (the development upstream), run this to update the public checkout, review the diff, and
# commit / open a PR in the public repo.
#
# Usage:
#   scripts/sync-public.sh /path/to/public-wavelength-checkout
#
# Source of truth = git-TRACKED files at HEAD (via `git archive`), NOT the working tree.
# That structurally guarantees no gitignored on-disk file (real *.auto.tfvars, tfplan,
# tfstate, .terraform, tokens) can ever leak into the public repo. We then drop the
# private/instance-only TRACKED paths (handoffs, Azure stacks, .claude) and, as defence in
# depth, run a leak gate that fails on any private identifier or em/en dash.

set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:?Usage: sync-public.sh /path/to/public-repo-checkout}"

if [ ! -d "$DEST" ]; then
  echo "error: destination '$DEST' is not a directory (clone/create the public repo first)" >&2
  exit 1
fi

# 1. Materialise ONLY tracked files (HEAD) into a temp tree.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
echo ">> Exporting tracked files at HEAD"
git -C "$SRC" archive --format=tar HEAD | tar -x -C "$TMP"

# 2. Drop private / instance-only tracked paths (public v1 = GCP; instance docs stay private).
rm -rf "$TMP/.claude" \
       "$TMP/iac/azure" "$TMP/iac/bootstrap/azure" \
       "$TMP/outline-azure"
rm -f  "$TMP/HANDOFF.md" "$TMP"/handoff-*.md
rm -f  "$TMP"/gateway/*.tf 2>/dev/null || true   # already removed from the repo; defensive

# 3. Sync the snapshot into the public checkout, preserving its .git and removing anything
#    no longer shipped.
echo ">> Syncing snapshot -> $DEST"
rsync -a --delete --exclude '.git/' "$TMP/" "$DEST/"

# 4. Leak gate (defence in depth).
echo ">> Running leak gate over $DEST"
PATTERN='\bCGA\b|cgam|netdaisy|cgamanagement|cga-management|730eb4ee|wavelength-cgam-749899|502947874860|869644586181|015E16|\bAndy\b|—|–'
# Exclude this script itself: it necessarily contains the pattern literals above.
if grep -rInE "$PATTERN" "$DEST" --exclude-dir='.git' --exclude='sync-public.sh'; then
  echo "" >&2
  echo "LEAK GATE FAILED: the matches above are private identifiers or forbidden dashes." >&2
  echo "Fix them in the SOURCE repo ($SRC), commit, then re-run." >&2
  exit 1
fi

echo ">> Tracked-only snapshot synced and leak gate clean. Review the diff in $DEST and commit/PR there."
