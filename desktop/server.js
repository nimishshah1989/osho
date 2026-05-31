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
 */
const http = require('node:http');
const handler = require('serve-handler');

/** Build (but don't listen on) the HTTP server that serves `rootDir`. */
function createOshoServer(rootDir) {
  return http.createServer((req, res) => {
    handler(req, res, {
      public: rootDir,
      cleanUrls: false,
      trailingSlash: true,
      directoryListing: false,
    });
  });
}

/** Start the server on a free 127.0.0.1 port. Resolves {server, origin}. */
function startServer(rootDir) {
  return new Promise((resolve, reject) => {
    const server = createOshoServer(rootDir);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

module.exports = { createOshoServer, startServer };
