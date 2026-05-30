/**
 * End-to-end offline-readiness gate for the desktop app.
 *
 * Unlike the earlier probe (which tested raw sqlite-wasm and missed the
 * Next.js bundling), this drives the REAL built static export through the
 * REAL desktop server, exactly as the packaged Electron app does — its
 * renderer is the same Chromium. It:
 *
 *   1. serves frontend/out via desktop/server.js,
 *   2. stages a tiny but valid corpus and points the app at it the same
 *      way the desktop shell does (window.oshoDesktop.corpusUrl),
 *   3. waits for the app to install + open the corpus and render the
 *      search UI (the DesktopGate only reveals the app once the engine is
 *      ready), then
 *   4. runs a real query and asserts a known result comes back.
 *
 * If the corpus can't be opened — e.g. the OPFS VFS regressed, or a
 * bundling change broke the worker — the app shows "Couldn't set up the
 * archive" and this test fails, so the build never produces installers.
 *
 * Requires the static export to be built first:
 *   (cd frontend && rm -rf app/api app/ask && DESKTOP_BUILD=true npx next build)
 * and Chromium from `npx playwright install chromium`.
 */
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, copyFileSync, rmSync } from 'node:fs';
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

// Stage the tiny corpus where the desktop shell expects the bundled one.
// The worker auto-detects raw SQLite vs .zst by magic bytes, so a raw
// .db under the .zst name is fine.
const corpusDir = path.join(OUT, 'corpus');
mkdirSync(corpusDir, { recursive: true });
copyFileSync(FIXTURE, path.join(corpusDir, 'osho.db.zst'));

const { server, origin } = await startServer(OUT);
const browser = await chromium.launch();
const errors = [];
try {
  const page = await browser.newPage();
  page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));

  // Become the desktop shell before any script runs.
  await page.addInitScript(() => {
    window.oshoDesktop = { corpusUrl: '/corpus/osho.db.zst' };
  });
  await page.goto(origin + '/index.html', { waitUntil: 'load' });

  // Resolve to the error screen or the ready app.
  let state = 'timeout';
  try {
    await page.waitForFunction(() => {
      const t = document.body.innerText || '';
      if (t.includes("Couldn't set up the archive")) return true;
      return !!document.querySelector('input'); // search UI present → ready
    }, { timeout: 90000 });
    state = await page.evaluate(() =>
      (document.body.innerText.includes("Couldn't set up the archive") ? 'error' : 'ready'));
  } catch { /* timeout */ }

  if (state !== 'ready') {
    const splash = await page.evaluate(() => (document.body.innerText || '').replace(/\s+/g, ' ').slice(0, 300));
    console.error('Splash:', splash);
    if (errors.length) console.error('Console errors:\n  ' + errors.slice(0, 8).join('\n  '));
    fail(`app did not reach ready state (was: ${state}). The packaged app would show `
      + `"Couldn't set up the archive".`);
  }

  // Prove the DB is actually queryable, not just that the UI painted.
  const box = await page.$('input');
  await box.fill('meditation');
  await box.press('Enter');
  let found = false;
  try {
    await page.waitForFunction(() => document.body.innerText.includes('Test Talk'), { timeout: 20000 });
    found = true;
  } catch { /* no result */ }
  if (!found) fail('search returned no results — the corpus opened but FTS query failed.');

  console.log('PASS: real bundled app installs + opens the corpus (SAHPool) and search works.');
} finally {
  await browser.close();
  server.close();
  try { rmSync(path.join(corpusDir, 'osho.db.zst')); } catch { /* ignore */ }
}
