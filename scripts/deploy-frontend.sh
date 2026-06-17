#!/usr/bin/env bash
# Frontend deploy — runs on the E2E VPS, invoked by deploy-frontend.yml
# over SSH as user `osho`.
#
# Idempotent: re-running is safe. The frontend runs under PM2 as the app
# `osho-frontend` (`next start` on :3000). PM2 runs as the `osho` user,
# so — unlike the backend's systemd restart — no sudo is needed here.
#
set -euo pipefail

REPO_DIR="${REPO_DIR:-/home/osho/osho}"
APP="${APP:-osho-frontend}"
PORT="${PORT:-3000}"
HEALTH_URL="http://127.0.0.1:${PORT}/"

cd "$REPO_DIR"

echo "==> Pre-pull HEAD: $(git rev-parse --short HEAD)"
BEFORE=$(git rev-parse HEAD)

# Look ahead: if the incoming pull would touch an untracked file in the
# working tree, `git pull --ff-only` aborts in ~1 second with a cryptic
# "untracked working tree files would be overwritten" message and the
# whole deploy silently 12-second-timeouts. Detect that case here and
# act on it deterministically:
#   - byte-identical to what we're about to pull → quietly remove the
#     untracked copy (the merge is a no-op for that file anyway), so a
#     manually-placed-then-later-committed file doesn't keep wedging
#     deploys (the 2026-05-30 incident with frontend/.env.production);
#   - different content → STOP and tell the operator exactly what to
#     do, instead of either silently overwriting their changes or dying
#     with the original opaque git error.
echo "==> Fetching origin to compare incoming vs working tree"
git fetch --quiet origin main
INCOMING="$(git rev-parse origin/main)"
CHANGED_INCOMING="$(git diff --name-only "HEAD..$INCOMING" || true)"
UNTRACKED="$(git ls-files --others --exclude-standard)"
for f in $CHANGED_INCOMING; do
  if echo "$UNTRACKED" | grep -qxF "$f"; then
    incoming_blob="$(git show "${INCOMING}:${f}" 2>/dev/null || true)"
    working_blob="$(cat "$f" 2>/dev/null || true)"
    if [ "$incoming_blob" = "$working_blob" ]; then
      echo "==> Untracked $f matches the incoming version — removing local copy"
      rm -f "$f"
    else
      echo "==> DEPLOY BLOCKED: untracked working-tree file would be overwritten:" >&2
      echo "       $f" >&2
      echo "    The file on the box differs from what the pull would install." >&2
      echo "    Move it aside so the deploy can proceed without losing your changes:" >&2
      echo "       mv $f ${f}.local-$(date +%Y-%m-%d)" >&2
      echo "    Then re-run the deploy. If the local file holds values the build" >&2
      echo "    needs (secrets, custom URLs), copy them into .env.local instead." >&2
      exit 1
    fi
  fi
done

echo "==> git pull"
git pull --ff-only origin main

AFTER=$(git rev-parse HEAD)
echo "==> Post-pull HEAD: $(git rev-parse --short HEAD)"

if [ "$BEFORE" = "$AFTER" ]; then
  CHANGED=""
  echo "==> No new commits."
else
  CHANGED=$(git diff --name-only "$BEFORE" "$AFTER")
  echo "==> Changed files:"
  echo "$CHANGED" | sed 's/^/    /'
fi

cd "$REPO_DIR/frontend"

# Install deps only when the lockfile or manifest changed — npm ci keeps
# node_modules in exact lockfile sync.
if echo "$CHANGED" | grep -qE '^frontend/package(-lock)?\.json$'; then
  echo "==> package manifest changed — npm ci"
  npm ci
fi

# Build from a clean slate. An in-place rebuild can leave orphaned chunks
# when a prior build was interrupted or OOM-killed: the new HTML ends up
# referencing chunk hashes whose files never got written (or that linger
# from an older build), so fresh visitors get 400s and a blank page while
# anyone with the old assets cached sees nothing wrong. Root cause of the
# 2026-06-16 blank-page incident. Costs a cold build (a few extra minutes)
# in exchange for a guaranteed-consistent output tree.
echo "==> Removing stale .next before build"
rm -rf .next

echo "==> npm run build"
npm run build

echo "==> Restarting PM2 app $APP"
pm2 restart "$APP" --update-env

# Healthcheck, two stages:
#   1. the homepage must answer on :3000;
#   2. every /_next/static asset the homepage references must ALSO serve
#      200. A build that emits the HTML but not all of its chunks (e.g.
#      OOM-killed mid-build) still answers 200 on '/', so stage 1 alone
#      passes while fresh visitors get 400s on the missing chunks and see
#      a blank page. Stage 2 turns that silent corruption into a loud,
#      failed deploy. (Root cause of the 2026-06-16 blank-page incident.)
echo "==> Healthchecking $HEALTH_URL"
ok=0
for i in $(seq 1 15); do
  sleep 1
  if curl -fsS --max-time 3 -o /dev/null "$HEALTH_URL"; then
    ok=1
    break
  fi
done

if [ "$ok" -ne 1 ]; then
  echo "==> DEPLOY FAILED — frontend not responding on $HEALTH_URL"
  echo "==> Last 50 PM2 log lines for $APP:"
  pm2 logs "$APP" --lines 50 --nostream 2>/dev/null || true
  exit 1
fi

echo "==> Verifying homepage static assets resolve (guards against incomplete builds)"
home_html="$(curl -fsS --max-time 5 "$HEALTH_URL" || true)"
assets="$(printf '%s' "$home_html" | grep -oE '/_next/static/[^"]+\.(js|css)' | sort -u || true)"
missing=0
checked=0
for a in $assets; do
  checked=$((checked + 1))
  code="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 5 "http://127.0.0.1:${PORT}${a}" || echo 000)"
  if [ "$code" != "200" ]; then
    echo "    MISSING ($code): $a" >&2
    missing=$((missing + 1))
  fi
done

if [ "$missing" -ne 0 ]; then
  echo "==> DEPLOY FAILED — $missing of $checked homepage assets do not resolve." >&2
  echo "    The served HTML references chunks that aren't on disk, so fresh" >&2
  echo "    visitors would get a blank page. Usually an incomplete build" >&2
  echo "    (often OOM-killed). Re-run the deploy; if it recurs, add swap or" >&2
  echo "    raise NODE_OPTIONS=--max-old-space-size for the build step." >&2
  exit 1
fi

echo "==> Frontend deploy OK ($checked static assets verified)"
