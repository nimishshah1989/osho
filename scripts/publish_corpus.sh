#!/usr/bin/env bash
# Build the compressed corpus + publish it to a GitHub Release asset.
# Runs on the E2E VPS. The release tag is stable (`corpus-latest`) so
# the PWA's `NEXT_PUBLIC_CORPUS_URL` never changes — every nightly run
# replaces the asset under the same tag.
#
# Requires:
#   - The corpus build script next to this one.
#   - `gh` CLI installed and authenticated as a token with `contents:write`.
#   - `GH_REPO` env var pointing at `owner/repo` (defaults to `nimishshah1989/osho`).
#
# Usage:
#   GH_REPO=nimishshah1989/osho ./scripts/publish_corpus.sh
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# Export REPO_DIR so the child build_corpus_artifact.sh resolves the
# same repo root instead of falling back to its own hardcoded default.
export REPO_DIR="${REPO_DIR:-$(dirname "$HERE")}"
ART_DIR="${ART_DIR:-${REPO_DIR}/data/artifacts}"
GH_REPO="${GH_REPO:-nimishshah1989/osho}"
TAG="${TAG:-corpus-latest}"

# 1. Build the artifact.
echo "==> Building corpus artifact"
"$HERE/build_corpus_artifact.sh"

ART="$ART_DIR/osho.db.zst"
SHA="$ART_DIR/osho.db.zst.sha256"
if [ ! -f "$ART" ] || [ ! -f "$SHA" ]; then
  echo "ERROR: expected $ART and $SHA to exist after build" >&2
  exit 2
fi

# 2. Ensure the release exists. `gh release view` errors when missing;
#    create it on first run.
if ! gh release view "$TAG" --repo "$GH_REPO" >/dev/null 2>&1; then
  echo "==> Creating release $TAG"
  gh release create "$TAG" \
    --repo "$GH_REPO" \
    --title "Offline corpus (rolling)" \
    --notes "Latest snapshot of the Osho Archives corpus, served to the offline PWA. Tag is intentionally stable: each nightly build replaces the asset under this same tag so the PWA's NEXT_PUBLIC_CORPUS_URL never changes." \
    --latest=false
fi

# 3. Replace the asset. `gh release upload --clobber` makes this
#    idempotent without leaking stale uploads.
echo "==> Uploading osho.db.zst + sha256"
gh release upload "$TAG" "$ART" "$SHA" --repo "$GH_REPO" --clobber

# Print the public URL the PWA fetches from. Operators can set this in
# Vercel's env vars: `NEXT_PUBLIC_CORPUS_URL`.
public_url="https://github.com/${GH_REPO}/releases/download/${TAG}/osho.db.zst"
echo "==> Done. Set NEXT_PUBLIC_CORPUS_URL=${public_url} on Vercel."
