# Osho Archives — desktop app

An Electron wrapper around the Osho Archives app, packaged as a
downloadable installer for Mac and Windows. **Fully offline** — the
entire archive is bundled inside the installer.

## How it works

The installer bundles two things:

- a **static copy of the frontend** (`desktop/app/`), and
- the **compressed corpus** (`desktop/app/corpus/osho.db.zst`).

`main.js` starts a tiny local HTTP server (`serve-handler`) on
`127.0.0.1` serving that directory, and points the window at it.
Serving over HTTP (not `file://`) means the renderer behaves exactly
like the web app on a real server — client routing, web workers and
OPFS all work as already tested in browsers.

`preload.js` exposes `window.oshoDesktop` to the frontend.
`OfflineProvider` sees it on first launch, fetches the bundled corpus
from the local server, and installs it into local storage. From then
on the app opens straight into search and works with **no internet** —
no download, no file-load step. `DesktopGate` shows a "Setting up…"
screen during that one-time first-launch install.

`desktop/app/` (frontend + corpus) is generated, not committed — CI
builds the frontend static export and downloads the corpus from the
`corpus-latest` GitHub release before packaging.

## Building the installers

Built by GitHub Actions — the **Build desktop app** workflow runs on
macOS and Windows runners and uploads the `.dmg` / `.exe` as
artifacts. Trigger it from the Actions tab (`workflow_dispatch`).

To build locally (only for the OS you're on):

```bash
# 1. Build the static frontend
cd frontend && npm install && npm run build:desktop

# 2. Stage it + the corpus into the desktop project
cd .. && rm -rf desktop/app && cp -r frontend/out desktop/app
mkdir -p desktop/app/corpus
curl -fL -o desktop/app/corpus/osho.db.zst \
  "https://github.com/nimishshah1989/osho/releases/download/corpus-latest/osho.db.zst"

# 3. Package
cd desktop && npm install && npm run dist   # output in desktop/dist/
```

## Notes

- The installer is **large** (~650 MB) — the whole archive is inside
  it. That's the trade for "download once, fully offline forever."
- Installers are **unsigned** — code-signing needs paid Apple /
  Microsoft developer accounts. Users get a one-time
  "unidentified developer" prompt on first launch (on macOS, the
  workaround is `xattr -cr "/Applications/Osho Archives.app"`).
