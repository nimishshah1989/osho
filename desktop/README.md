# Osho Archives — desktop app

An Electron wrapper around the Osho Archives app, packaged as a
downloadable installer for Mac and Windows.

## Status

**Phase 2a (current).** The app ships a **static copy of the
frontend** inside the installer and serves it from a local HTTP
server — so it no longer depends on the live website to load. Offline
search still works by loading the corpus file (the `/downloadapp`
flow) inside the app.

**Phase 2b (planned).** Also bundle the compressed corpus inside the
installer and auto-install it on first launch, so the app is fully
offline immediately — no download, no file-load step.

## How it works

`main.js` starts a tiny local HTTP server (`serve-handler`) on
`127.0.0.1` serving `desktop/app/` — the static frontend — and points
the window at it. Serving over HTTP (rather than `file://`) means the
renderer behaves exactly like the web app on a real server: client
routing, web workers and OPFS all work as already tested in browsers.

`desktop/app/` is generated, not committed — CI builds the frontend
static export (`frontend/out`) and copies it in before packaging.

## Building the installers

Built by GitHub Actions — the **Build desktop app** workflow runs on
macOS and Windows runners and uploads the `.dmg` / `.exe` as
artifacts. Trigger it from the Actions tab (`workflow_dispatch`).

To build locally (only for the OS you're on):

```bash
# 1. Build the static frontend
cd frontend && npm install && npm run build:desktop

# 2. Stage it into the desktop project
cd .. && rm -rf desktop/app && cp -r frontend/out desktop/app

# 3. Package
cd desktop && npm install && npm run dist   # output in desktop/dist/
```

## Notes

- Installers are **unsigned** — code-signing needs paid Apple /
  Microsoft developer accounts. Users get a one-time
  "unidentified developer" prompt on first launch (on macOS, the
  workaround is `xattr -cr "/Applications/Osho Archives.app"`).
