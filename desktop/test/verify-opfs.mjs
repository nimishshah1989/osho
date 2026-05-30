/**
 * Offline-readiness gate for the desktop app.
 *
 * The desktop app stores the bundled archive in OPFS via sqlite-wasm,
 * which only works when the renderer is `crossOriginIsolated`. That flag
 * is controlled entirely by the two headers in desktop/server.js
 * (COI_HEADERS). Without them the app throws "sqlite-wasm built without
 * OPFS support." on first launch — the bug fixed 2026-05-30.
 *
 * This test guards that exact regression in two faithful parts:
 *
 *   Part A — the real `createOshoServer` from server.js must actually
 *            emit COOP:same-origin + COEP:require-corp on its responses
 *            (and must NOT when headers are disabled). Proves the server
 *            applies the policy.
 *
 *   Part B — those exact header VALUES, imported from server.js, must
 *            make a real Chromium `crossOriginIsolated` and let
 *            sqlite-wasm open an OPFS database and round-trip a query.
 *            A negative control (no headers) must fail to get OPFS,
 *            proving the test has teeth and isn't a no-op. Electron's
 *            renderer is Chromium, so headless Chromium here faithfully
 *            reproduces what the packaged app does.
 *
 * Exit non-zero — failing the desktop build in CI — if any expectation
 * is violated. This is the check that stops a broken-offline build from
 * shipping again.
 *
 * Run:  npm run verify:offline
 *   (needs `npm install` in desktop/, sqlite-wasm in ../frontend/node_modules,
 *    and `npx playwright install chromium`.)
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { mkdtempSync, copyFileSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { createOshoServer, startServer, COI_HEADERS } = require('../server.js');
const { chromium } = require('playwright');

const sqliteEntry = require.resolve('@sqlite.org/sqlite-wasm', {
  paths: [path.join(HERE, '..', '..', 'frontend')],
});
const SQLITE_DIST = path.dirname(sqliteEntry);

const fail = (msg) => { console.error('\nFAIL: ' + msg); process.exit(1); };

// ── Part A: the real server applies (and omits) the headers ──────────────

async function partA() {
  const root = mkdtempSync(path.join(tmpdir(), 'osho-hdr-'));
  writeFileSync(path.join(root, 'x.txt'), 'hi');
  try {
    for (const withCoiHeaders of [true, false]) {
      const { server, origin } = await startServer(root, { withCoiHeaders });
      try {
        const r = await fetch(origin + '/x.txt');
        const coop = r.headers.get('cross-origin-opener-policy');
        const coep = r.headers.get('cross-origin-embedder-policy');
        if (withCoiHeaders && !(coop === 'same-origin' && coep === 'require-corp')) {
          fail(`server did not emit COI headers (got COOP=${coop}, COEP=${coep})`);
        }
        if (!withCoiHeaders && (coop || coep)) {
          fail(`server emitted COI headers when disabled (COOP=${coop}, COEP=${coep})`);
        }
      } finally {
        server.close();
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
  console.log('Part A OK — createOshoServer applies COOP/COEP exactly when expected.');
}

// ── Part B: those header values actually enable OPFS in real Chromium ────

const WORKER_JS = `
import init from './index.mjs';
(async () => {
  const r = { coi: globalThis.crossOriginIsolated === true, opfsDbDefined: false,
              opfsOpenWorked: false, queryRoundTripped: false, error: null };
  try {
    const s = await init({ print: () => {}, printErr: () => {} });
    r.opfsDbDefined = !!s.oo1?.OpfsDb;       // the exact gate dbWorker.ts checks
    if (r.opfsDbDefined) {
      const db = new s.oo1.OpfsDb('/verify-' + Math.random().toString(36).slice(2) + '.db', 'c');
      r.opfsOpenWorked = true;
      db.exec("CREATE TABLE t(x TEXT)");
      db.exec("INSERT INTO t VALUES('hello-opfs')");
      const rows = [];
      db.exec({ sql: 'SELECT x FROM t', rowMode: 'array', callback: (row) => rows.push(row[0]) });
      r.queryRoundTripped = rows[0] === 'hello-opfs';
      db.close();
    }
  } catch (e) { r.error = String(e?.message ?? e); }
  postMessage(r);
})();`;

const INDEX_HTML = `<!doctype html><meta charset=utf-8>
<script type=module>
  const w = new Worker('./worker.mjs', { type: 'module' });
  w.onmessage = e => { window.__R__ = e.data; };
  w.onerror = e => { window.__R__ = { error: 'worker: ' + (e.message || e) }; };
</script>`;

// `.js` MUST be a JS MIME: sqlite-wasm's OPFS async-proxy worker is a .js
// file, and a worker served as octet-stream silently fails to load, which
// would make OPFS look unavailable even when the headers are correct.
const MIME = {
  '.html': 'text/html', '.mjs': 'text/javascript',
  '.js': 'text/javascript', '.wasm': 'application/wasm',
};

// A minimal flat-file server that applies the header set under test. We
// don't reuse createOshoServer here because its `trailingSlash` option
// (correct for the Next.js export it normally serves) interferes with the
// flat sqlite-wasm dist files this probe stages. The HEADER VALUES — the
// thing that actually matters and that we're guarding — are imported
// straight from server.js, so weakening them still fails this test.
function flatServer(root, applyHeaders) {
  return http.createServer((req, res) => {
    const u = req.url === '/' ? '/index.html' : req.url.split('?')[0];
    try {
      const buf = readFileSync(path.join(root, u));
      res.setHeader('Content-Type', MIME[path.extname(u)] || 'application/octet-stream');
      if (applyHeaders) {
        for (const [k, v] of Object.entries(COI_HEADERS)) res.setHeader(k, v);
      }
      res.end(buf);
    } catch {
      res.statusCode = 404;
      res.end('not found');
    }
  });
}

async function probeOpfs(applyHeaders) {
  const root = mkdtempSync(path.join(tmpdir(), 'osho-opfs-'));
  for (const f of ['index.mjs', 'sqlite3.wasm', 'sqlite3-opfs-async-proxy.js']) {
    copyFileSync(path.join(SQLITE_DIST, f), path.join(root, f));
  }
  writeFileSync(path.join(root, 'worker.mjs'), WORKER_JS);
  writeFileSync(path.join(root, 'index.html'), INDEX_HTML);

  const server = flatServer(root, applyHeaders);
  await new Promise((res) => server.listen(0, '127.0.0.1', res));
  const port = server.address().port;
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__R__ !== undefined, { timeout: 30000 });
    return await page.evaluate(() => window.__R__);
  } finally {
    await browser.close();
    server.close();
    rmSync(root, { recursive: true, force: true });
  }
}

async function partB() {
  const on = await probeOpfs(true);
  const off = await probeOpfs(false);
  console.log('WITH headers   :', JSON.stringify(on));
  console.log('WITHOUT headers:', JSON.stringify(off));

  if (!(on.coi && on.opfsDbDefined && on.opfsOpenWorked && on.queryRoundTripped)) {
    fail('OPFS did not work with the COI headers — the desktop app would show '
      + '"sqlite-wasm built without OPFS support."');
  }
  if (off.opfsDbDefined !== false) {
    fail('negative control unexpectedly had OPFS — the test is not exercising the '
      + 'header behaviour and cannot guard the regression.');
  }
  console.log('Part B OK — COI_HEADERS make OPFS work; absent without them (control holds).');
}

await partA();
await partB();
console.log('\nPASS: desktop offline OPFS path verified.');
