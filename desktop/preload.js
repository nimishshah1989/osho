'use strict';

/**
 * Preload — runs in the renderer before the page scripts, with access
 * to a minimal Electron surface. It exposes one thing: a flag telling
 * the frontend it's running inside the desktop app, plus the local URL
 * of the corpus bundled in the installer.
 *
 * OfflineProvider reads `window.oshoDesktop?.corpusUrl` on first launch
 * and installs that corpus automatically. On the plain website
 * `window.oshoDesktop` is undefined, so nothing changes there.
 */
const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('oshoDesktop', {
  // Served by the app's local HTTP server (see main.js) from the
  // bundled desktop/app/corpus/ directory.
  corpusUrl: '/corpus/osho.db.zst',
});
