'use strict';

/**
 * The desktop app's local static server — extracted from main.js so it
 * carries NO electron dependency and can be exercised directly by the
 * offline-verification test (test/verify-offline.mjs).
 *
 * NOTE on storage: the app stores the corpus via sqlite-wasm's OPFS
 * **SAHPool** VFS (see frontend/lib/search/worker/dbWorker.ts), which
 * uses synchronous OPFS access handles directly in the worker. It needs
 * neither SharedArrayBuffer nor cross-origin isolation. We deliberately
 * do NOT send COOP/COEP here: those make the renderer crossOriginIsolated,
 * which makes sqlite-wasm try to auto-init its *default* "opfs" VFS — a
 * nested async-proxy worker that can't be resolved in the Next.js-bundled
 * build and throws "Expecting vfs=opfs|opfs-wl URL argument for this
 * worker" (the 2026-05-30 desktop failure). SAHPool sidesteps all of it.
 *
 * NOTE on port: Chromium scopes OPFS storage by origin (host + port),
 * so an Electron app that listens on `port: 0` (OS-assigned, different
 * every launch) gets a different origin each time → empty OPFS →
 * ~1.6 GB corpus reinstall on every relaunch. We pin a small range of
 * high ports so the origin is stable across launches and OPFS persists.
 * If all preferred ports are taken (truly rare on a desktop), we fall
 * back to an OS-assigned port and accept the one-time reinstall.
 */
const http = require('node:http');
const handler = require('serve-handler');

// Picked once, deliberately uncommon and well above all the standard dev
// ports a user might run alongside the app. The fallback range covers
// the very rare case where some other process already owns the first one.
const PREFERRED_PORTS = [17789, 17790, 17791, 17792, 17793];

/** Build (but don't listen on) the HTTP server that serves `rootDir`. */
function createOshoServer(rootDir) {
  return http.createServer((req, res) => {
    handler(req, res, {
      public: rootDir,
      // Defaults except for `directoryListing`. The previous config
      // (`cleanUrls: false, trailingSlash: true`) silently broke every
      // route in the static export — `/` returned 404 (the white
      // "404: This page could not be found." window the user saw),
      // `/archive/` and `/read/` did too, and static assets only
      // resolved via 301 redirect chains. serve-handler's default
      // `cleanUrls: true` is exactly what makes `out/foo/index.html`
      // be served for the request `/foo` or `/foo/`. We only override
      // directoryListing to false so a misconfigured deploy can never
      // expose the file tree.
      directoryListing: false,
    });
  });
}

/** Start the server, preferring a stable port so OPFS storage persists
 *  across app launches. Resolves {server, origin, persistent} — where
 *  persistent=false means we fell back to an OS-assigned port and the
 *  corpus will be reinstalled next launch. */
function startServer(rootDir) {
  return (async () => {
    for (const port of PREFERRED_PORTS) {
      try {
        const server = createOshoServer(rootDir);
        await new Promise((resolve, reject) => {
          const onErr = (e) => {
            server.removeListener('error', onErr);
            reject(e);
          };
          server.once('error', onErr);
          server.listen(port, '127.0.0.1', () => {
            server.removeListener('error', onErr);
            resolve();
          });
        });
        return { server, origin: `http://127.0.0.1:${port}`, persistent: true };
      } catch (e) {
        if (e && e.code === 'EADDRINUSE') continue; // try next preferred port
        throw e;
      }
    }
    // Every preferred port was busy — fall back to an OS-assigned port.
    // Storage won't persist across launches, but the app still works.
    return new Promise((resolve, reject) => {
      const server = createOshoServer(rootDir);
      server.on('error', reject);
      server.listen(0, '127.0.0.1', () => {
        console.warn(
          '[osho] All preferred ports were in use — using an OS-assigned port. '
          + 'The offline archive will be reinstalled on next launch.',
        );
        resolve({
          server,
          origin: `http://127.0.0.1:${server.address().port}`,
          persistent: false,
        });
      });
    });
  })();
}

module.exports = { createOshoServer, startServer, PREFERRED_PORTS };
