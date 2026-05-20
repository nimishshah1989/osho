# Osho Archives — desktop app

An Electron wrapper around the Osho Archives app, packaged as a
downloadable installer for Mac and Windows.

## Status

**Phase 1 (current).** The app is a dedicated window onto the live
site (`oshoarchives.com`). Its purpose is to prove out the build /
packaging / CI pipeline. Offline still works the same way it does in a
browser — install the app, then load the corpus file (the existing
`/downloadapp` flow).

**Phase 2 (planned).** Bundle a static copy of the frontend and the
compressed corpus *inside* the installer, served over a local `app://`
protocol, so the app is fully offline from first launch — no download,
no file-load step. Plus the app icon.

## Building the installers

Installers are built by GitHub Actions, not by hand — the **Build
desktop app** workflow runs on macOS and Windows runners and uploads
the `.dmg` / `.exe` as artifacts. Trigger it from the Actions tab
(`workflow_dispatch`).

To build locally (you can only build for the OS you're on):

```bash
cd desktop
npm install
npm run dist        # output in desktop/dist/
```

## Notes

- Installers are **unsigned** — code-signing needs paid Apple /
  Microsoft developer accounts. Users get a one-time
  "unidentified developer" prompt on first launch.
- `npm start` runs the app against the live site for quick local
  iteration.
