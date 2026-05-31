/**
 * End-to-end offline-readiness gate for the desktop app.
 *
 * Drives the REAL built static export through the REAL desktop server,
 * exactly as the packaged Electron app does — its renderer is the same
 * Chromium. Two scenarios:
 *
 *   Scenario A — fresh install:
 *     1. serves frontend/out via desktop/server.js
 *     2. stages a tiny but valid corpus and points the app at it the same
 *        way the desktop shell does (window.oshoDesktop.corpusUrl)
 *     3. waits for the app to install + open the corpus and render the
 *        search UI (the DesktopGate only reveals the app once the engine
 *        is ready), then
 *     4. runs a real query and asserts a known result comes back.
 *
 *   Scenario B — relaunch persistence:
 *     1. closes the browser and re-opens it with the SAME persistent
 *        profile (OPFS persists across launches the same way it would
 *        in the packaged Electron app)
 *     2. starts a NEW server process to mimic each Electron launch
 *        starting its own server, and
 *     3. asserts the corpus is NOT re-fetched from /corpus/osho.db.zst.
 *     If the server's port changed between launches (Electron's old
 *     `port: 0` behaviour) the origin changes, OPFS is empty, and the
 *     full corpus gets reinstalled — the 2026-05-30 "reloads the whole
 *     book every relaunch" bug. desktop/server.js now pins a stable
 *     port range so this stays gated.
 *
 * Exit non-zero — failing the desktop build in CI — if any expectation
 * is violated.
 *
 * Requires the static export to be built first:
 *   (cd frontend && rm -rf app/api app/ask && DESKTOP_BUILD=true npx next build)
 * and Chromium from `npx playwright install chromium`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const { startServer } = require('../server.js');
const { chromium } = require('playwright');

const OUT = path.join(HERE, '..', '..', 'frontend', 'out');
const FIXTURE = path.join(HERE, 'fixtures', 'tiny-corpus.db');

const fail = (msg) => { console.error('\nFAIL: ' + msg); process.exit(1); };

if (!existsSync(OUT)) {
  fail(`static export not found at ${OUT}\n`
    + 'Build it first: cd frontend && rm -rf app/api app/ask && DESKTOP_BUILD=true npx next build');
}

const corpusDir = path.join(OUT, 'corpus');
mkdirSync(corpusDir, { recursive: true });
copyFileSync(FIXTURE, path.join(corpusDir, 'osho.db.zst'));

const profile = mkdtempSync(path.join(tmpdir(), 'osho-offline-'));

/** Launch a persistent browser at `profile`, wait for the app to be
 *  ready, run a search, and report whether the corpus was re-fetched.
 *  Each call starts and stops its own server — exactly like a real
 *  Electron app launch. */
async function launch(label) {
  const { server, origin, persistent } = await startServer(OUT);
  if (!persistent) {
    server.close();
    fail(`server fell back to an OS-assigned port (origin=${origin}) — the `
      + 'preferred ports were unavailable on this runner, so persistence cannot be tested.');
  }
  const errors = [];
  const ctx = await chromium.launchPersistentContext(profile);
  try {
    const page = await ctx.newPage();
    page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
    page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
    await page.addInitScript(() => {
      window.oshoDesktop = { corpusUrl: '/corpus/osho.db.zst' };
    });
    let corpusFetched = false;
    page.on('request', (r) => {
      if (r.url().endsWith('/corpus/osho.db.zst')) corpusFetched = true;
    });
    // Load `/` exactly like main.js does (`win.loadURL(origin)`) — this
    // gates against the 2026-05-30 white-404 routing regression.
    await page.goto(origin + '/', { waitUntil: 'load' });
    let state = 'timeout';
    try {
      await page.waitForFunction(() => {
        const t = document.body.innerText || '';
        if (t.includes("Couldn't set up the archive")) return true;
        return !!document.querySelector('input');
      }, { timeout: 90000 });
      state = await page.evaluate(() =>
        (document.body.innerText.includes("Couldn't set up the archive") ? 'error' : 'ready'));
    } catch { /* timeout */ }

    if (state !== 'ready') {
      const splash = await page.evaluate(() =>
        (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300));
      console.error(`${label} splash:`, splash);
      if (errors.length) console.error('  console errors:\n    ' + errors.slice(0, 8).join('\n    '));
      fail(`${label}: app did not reach ready state. The packaged app would show `
        + `"Couldn't set up the archive".`);
    }

    // Prove the DB is queryable, not just that the UI painted.
    const box = await page.$('input');
    await box.fill('meditation');
    await box.press('Enter');
    try {
      await page.waitForFunction(() => document.body.innerText.includes('Test Talk'), { timeout: 20000 });
    } catch {
      fail(`${label}: search returned no results — the corpus opened but FTS query failed.`);
    }

    return { origin, corpusFetched };
  } finally {
    await ctx.close();
    server.close();
  }
}

try {
  // Scenario A — first launch performs a fresh install and queries the DB.
  const first = await launch('FIRST launch');
  if (!first.corpusFetched) {
    fail('FIRST launch did not fetch the corpus — the test fixture or the install '
      + 'flow is broken; later assertions would not be meaningful.');
  }
  console.log(`Scenario A OK — fresh install + search works (origin=${first.origin}).`);

  // Scenario B — relaunch. NEW server (potentially new port), SAME profile
  // (OPFS persists). The fix in desktop/server.js pins the port so the
  // origin matches the first launch and OPFS is visible.
  const second = await launch('SECOND launch');
  if (second.origin !== first.origin) {
    fail(`SECOND launch got a different origin (${second.origin} vs ${first.origin}) — `
      + 'the pinned-port logic in desktop/server.js regressed. The packaged app would '
      + 'reinstall the corpus on every relaunch.');
  }
  if (second.corpusFetched) {
    fail('SECOND launch RE-FETCHED the corpus — OPFS persistence is broken. The '
      + 'packaged app would reload the entire ~1.6 GB archive on every relaunch '
      + '(the 2026-05-30 "reloads the whole book" bug).');
  }
  console.log('Scenario B OK — relaunch is instant: same origin, corpus not re-fetched.');

  console.log('\nPASS: install works, relaunch persists.');
} finally {
  try { rmSync(path.join(corpusDir, 'osho.db.zst')); } catch { /* ignore */ }
  try { rmSync(profile, { recursive: true, force: true }); } catch { /* ignore */ }
}
