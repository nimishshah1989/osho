'use strict';

/**
 * The desktop app's local static server — extracted from main.js so it
 * carries NO electron dependency and can be exercised directly by the
 * offline-verification test (test/verify-opfs.mjs).
 *
 * CRITICAL: the two cross-origin-isolation headers below are what make
 * the renderer `crossOriginIsolated`, which is the ONLY thing that
 * switches on sqlite-wasm's OPFS storage engine. Without them the app
 * throws "sqlite-wasm built without OPFS support." on first launch
 * (the bug fixed 2026-05-30). Electron's renderer is Chromium and
 * treats http://127.0.0.1 as a secure context, so these headers take
 * effect exactly as they do in a browser.
 *
 * DO NOT remove or weaken these without updating test/verify-opfs.mjs —
 * that test fails the desktop build in CI if OPFS can't be opened.
 */
const http = require('node:http');
const handler = require('serve-handler');

const COI_HEADERS = {
  'Cross-Origin-Opener-Policy': 'same-origin',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * Build (but don't listen on) the HTTP server that serves `rootDir`.
 * `withCoiHeaders=false` exists only so the test can run a negative
 * control proving the headers are what make OPFS work.
 */
function createOshoServer(rootDir, { withCoiHeaders = true } = {}) {
  return http.createServer((req, res) => {
    if (withCoiHeaders) {
      for (const [k, v] of Object.entries(COI_HEADERS)) res.setHeader(k, v);
    }
    handler(req, res, {
      public: rootDir,
      cleanUrls: false,
      trailingSlash: true,
      directoryListing: false,
    });
  });
}

/** Start the server on a free 127.0.0.1 port. Resolves {server, origin}. */
function startServer(rootDir, opts = {}) {
  return new Promise((resolve, reject) => {
    const server = createOshoServer(rootDir, opts);
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      resolve({ server, origin: `http://127.0.0.1:${server.address().port}` });
    });
  });
}

module.exports = { createOshoServer, startServer, COI_HEADERS };
