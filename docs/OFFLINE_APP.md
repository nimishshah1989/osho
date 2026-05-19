# Osho Archives — Offline app

A single URL — `https://oshoarchives.com` — installs as a PWA on every
modern device, downloads the corpus once over Wi-Fi, and then works
fully offline. No app stores. No signing certificates. Updates ride
on top of the existing Vercel deploys.

This document is the operator's runbook + the end-user install guide
in one place. If you're shipping a corpus update, read **Operators**.
If you're a sannyasin trying to install on a phone or laptop, read
**Install**.

---

## Install

### Android (Chrome, Edge, Samsung Internet, …)

1. Open `https://oshoarchives.com` in Chrome.
2. After a few seconds the browser will pop a **"Install app"** banner
   at the bottom. If you miss it, tap ⋮ → **Install app**.
3. Confirm — the app lands on the home screen with the gold ॐ icon.
4. Open it. A small banner at the top will start downloading the
   offline corpus (~400 MB compressed). You can keep using the app
   over the existing connection while this happens; the banner shows
   progress. Tap **×** to hide the banner (download continues).
5. Once the banner flips to **Offline ready**, future launches work
   with no network — even in airplane mode.

### iOS / iPadOS (Safari 16.4 or newer)

1. Open `https://oshoarchives.com` in Safari.
2. Tap the Share button (square with up-arrow) → **Add to Home Screen**.
3. Confirm — app icon lands on the home screen.
4. Open it from the home-screen icon (not from the browser tab).
   The first launch downloads the corpus the same way as Android.
5. Once "Offline ready" appears, future launches work with no network.

iOS quirks: older iOS versions (16.3 and below) don't support OPFS,
so the app will quietly stay online-only on those devices. Updating
iOS fixes it.

### Desktop (macOS / Windows / Linux)

In Chrome or Edge:

1. Visit `https://oshoarchives.com`.
2. Click the **install icon** in the address bar (a tiny monitor with
   a down-arrow), or use the **Install app** button in the top right
   of the page.
3. The app opens in its own window — no browser chrome, dock / Start
   menu icon, the works.
4. First launch downloads the corpus, same flow as mobile.

In Safari on macOS 14 (Sonoma) or newer: **File → Add to Dock**.
Older Safari and Firefox don't support PWA install — you can still
use the site as a tab, and offline search works via OPFS once the
corpus is cached.

### Sharing the installed app

The "installer" is just the URL. Share the link to
`https://oshoarchives.com` by message, QR code, or printed on a
flyer — every recipient on a modern device can install the same app
the same way. No app-store search, no developer account, no waiting
for review.

---

## How the offline path works (under the hood)

```
First launch
  visit oshoarchives.com
    └─ service worker registers          (instant)
    └─ "Install app" prompt appears      (browser-driven)
    └─ Offline corpus check (OPFS)       → not present
    └─ Background download begins        (NEXT_PUBLIC_CORPUS_URL)
        ▼
    /api/* still serves queries while download runs.
        ▼
    Download decompresses straight into OPFS via SAH.
        ▼
    Worker opens the OPFS database via sqlite-wasm.
        ▼
    Engine becomes available. Future queries run locally.

Subsequent launches
  visit oshoarchives.com (online OR offline)
    └─ service worker serves the app shell from cache
    └─ Offline corpus check (OPFS)       → present
    └─ Worker opens it immediately
    └─ Every search runs against the local copy
```

---

## Operators

### Where the corpus lives

The compressed corpus (`osho.db.zst`, ~400 MB) is attached as an
asset to a stable GitHub Release: `corpus-latest`. The PWA fetches
from there via the env var `NEXT_PUBLIC_CORPUS_URL`, which is
configured in Vercel project settings:

```
NEXT_PUBLIC_CORPUS_URL=https://github.com/nimishshah1989/osho/releases/download/corpus-latest/osho.db.zst
```

If the env var is unset, the offline path is silently disabled and
the app falls back to the FastAPI proxy — useful for local dev.

### Refreshing the corpus

Two ways:

**1. Nightly cron (preferred).**
`.github/workflows/publish-corpus.yml` runs every night at 02:00 UTC.
It SSHes into EC2, runs `scripts/publish_corpus.sh`, which:

1. Online-backs-up the live `data/osho.db` (so the API stays up
   throughout).
2. Runs `VACUUM` + `INSERT INTO paragraphs_fts(paragraphs_fts) VALUES('optimize')`
   to shrink the copy.
3. Compresses with `zstd -19 --long --T0`.
4. Uploads `osho.db.zst` + a SHA-256 sidecar to the
   `corpus-latest` release, replacing the previous asset under the
   same name.

The PWA's service worker has the corpus in its own cache bucket
(`osho-corpus-v1`), version-independent of the app shell. To get a
user onto the new corpus they currently need to either clear site
data or wait for the cache to be evicted. (A future PR will add a
small "Refresh corpus" button in the offline banner that does this
cleanly.)

**2. Manual trigger.**
After a big archival edit (e.g. Sugit's batch ingest), trigger the
workflow from the Actions tab → **Publish offline corpus** → **Run
workflow**. The asset replaces in ~2 minutes.

### Required secrets

The publish workflow uses the same EC2 secrets the backend-deploy
workflow does: `BACKEND_HOST`, `BACKEND_USER`, `BACKEND_SSH_KEY`,
optionally `BACKEND_PORT`. No new secrets needed — `GITHUB_TOKEN`
is auto-provided by Actions.

### First-time setup on EC2

`gh` and `zstd` will be installed automatically by the workflow on
first run. If you want to test the publish flow manually on EC2:

```bash
# Use whichever key / host you have configured in the BACKEND_SSH_KEY
# and BACKEND_HOST repo secrets — they aren't checked in here so this
# doc stays safe to publish.
ssh -i PATH_TO_KEY ubuntu@BACKEND_HOST
cd /home/ubuntu/osho-speaks
# Authenticate gh with a PAT that has contents:write on the repo.
gh auth login
GH_REPO=nimishshah1989/osho bash scripts/publish_corpus.sh
```

### What if the publish fails?

The job log on the Actions tab is the first stop. The most likely
failure modes:

| Symptom | Cause | Fix |
| --- | --- | --- |
| `gh release create` fails with 403 | `GITHUB_TOKEN` lacks `contents:write` | Repo → Settings → Actions → Workflow permissions → "Read and write" |
| `zstd: command not found` | First-run install hasn't happened yet | Re-run the workflow; the install step is idempotent |
| `mv: cross-device link` from build script | `mktemp` ended up on a different filesystem | Set `ART_DIR` to point at the live data partition |
| Upload times out on 400 MB | EC2 → GitHub bandwidth dropping | Retry the workflow; uploads are idempotent (`--clobber`) |

### Disabling offline (temporarily)

Unset `NEXT_PUBLIC_CORPUS_URL` in Vercel. Next user load won't start
the download; the UI silently falls back to the API. Users with the
corpus already installed keep using it — their next visit re-detects
the env var via the service worker update.

### Local dev

Set in your `frontend/.env.local`:

```
# Either omit (silent fallback) or point at a local server:
# NEXT_PUBLIC_CORPUS_URL=http://localhost:8080/osho.db.zst
```

For a quick test:

```bash
# Build the artifact locally.
bash scripts/build_corpus_artifact.sh
# Serve it from data/artifacts/ on :8080:
python3 -m http.server -d data/artifacts 8080
# In frontend/.env.local:
NEXT_PUBLIC_CORPUS_URL=http://localhost:8080/osho.db.zst
npm run dev
```

---

## Troubleshooting

### "Couldn't download for offline use"

The banner shows the underlying reason. Most common causes:

- **No connection** at the moment of download. Tap **Retry**.
- **Storage full**. OPFS quota varies by browser; ~2 GB free is a
  safe minimum for the corpus. Free up space and retry.
- **Corrupt download**. Tap **Retry**; the worker re-fetches.

If the failure persists, in DevTools → Application → Storage → Clear
site data, then reload. The next launch re-attempts cleanly.

### App opens but search returns no results

This usually means the offline corpus opened but a stale schema is
in OPFS. Clear site data (as above) to re-trigger the download.
A "force refresh corpus" button will land in a later PR.

### "Install" button never appears

The PWA install prompt only fires once per origin per browser
session and only when the browser's heuristic decides the user is
engaged (browse a couple of pages, return after some time, etc.).
On iOS Safari there is no prompt at all — use Share → Add to Home
Screen.
