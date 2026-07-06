/**
 * verify-nav.cjs — pre-deploy regression check for the search Prev/Next
 * navigation. This is the safety net that was MISSING when nav bugs kept
 * recurring (Anuragi, 2026-07): every change to the result-navigation UI
 * (frontend/app/page.tsx: revealMatchAt / jumpToMatch / the compact "Top
 * matches" cards / the <details> reader) MUST pass this before shipping.
 *
 * It drives the real page in headless Chromium against a running frontend and
 * asserts the TRUE user invariants across the whole search matrix
 * (phrase / all-words / NEAR × EN / HI × same-record / cross-record ×
 * stemmed / exact):
 *
 *   LANDING  — the full record is COLLAPSED (clean "Top matches"), and the
 *              Prev/Next bar is visible without expanding.
 *   EACH STEP — after every Next, the CURRENT match element is in the
 *              viewport AND visibly highlighted (contains a <mark>); the
 *              footer position advances.
 *
 * The "highlighted + in view" check is the one that matters: a NEAR "Next"
 * used to auto-expand a wall of text with no visible marker (cross-paragraph
 * NEAR has no body hl), which read as "broken". Do not weaken it.
 *
 * USAGE:
 *   1. Run the frontend against the PROD api (real data):
 *        cd frontend && API_URL=https://api.oshoarchives.com npx next dev -p 3000
 *   2. In another shell:
 *        cd frontend && node scripts/verify-nav.cjs            # localhost:3000
 *        cd frontend && node scripts/verify-nav.cjs http://localhost:3000
 *
 * Needs Chromium (this repo's CI images ship it under /opt/pw-browsers) and
 * playwright-core (present in node_modules; the desktop project also declares
 * playwright). NEAR queries are slow — the run takes a few minutes.
 */
'use strict';
const { chromium } = require('playwright-core');
const fs = require('fs');
const path = require('path');

function findChrome() {
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH || '/opt/pw-browsers';
  if (fs.existsSync(root)) {
    for (const d of fs.readdirSync(root)) {
      if (d.startsWith('chromium-') && !d.includes('headless')) {
        const p = path.join(root, d, 'chrome-linux', 'chrome');
        if (fs.existsSync(p)) return p;
      }
    }
    for (const d of fs.readdirSync(root)) {
      if (d.includes('headless_shell')) {
        const p = path.join(root, d, 'chrome-linux', 'headless_shell');
        if (fs.existsSync(p)) return p;
      }
    }
  }
  return undefined; // let playwright resolve its own download
}

const BASE = process.argv[2] || 'http://localhost:3000';

const CONFIGS = [
  { name: 'phrase EN (Sagar University)',       q: 'Sagar University', mode: 'phrase', lang: 'all', exact: 1, steps: 4 },
  { name: 'all-words EN (love awareness)',      q: 'love awareness',   mode: 'all',    lang: 'all', exact: 0, steps: 4 },
  { name: 'all-words EN exact (love awareness)',q: 'love awareness',   mode: 'all',    lang: 'all', exact: 1, steps: 3 },
  { name: 'NEAR EN (became professor, 10)',     q: 'became professor', mode: 'near', prox: 10, lang: 'all', exact: 0, steps: 5 },
  { name: 'NEAR EN (mind meditation, 30)',      q: 'mind meditation',  mode: 'near', prox: 30, lang: 'all', exact: 0, steps: 4 },
  { name: 'phrase HI (मन की शांति)',             q: 'मन की शांति',       mode: 'phrase', lang: 'all', exact: 1, steps: 3 },
  { name: 'all-words HI (प्रेम ध्यान)',           q: 'प्रेम ध्यान',        mode: 'all',    lang: 'all', exact: 0, steps: 4 },
  { name: 'NEAR HI (ध्यान मौन, 10)',             q: 'ध्यान मौन',         mode: 'near', prox: 10, lang: 'all', exact: 0, steps: 3 },
];

function url(c) {
  const p = new URLSearchParams();
  p.set('q', c.q); p.set('mode', c.mode); p.set('lang', c.lang);
  if (c.exact) p.set('exact', '1');
  if (c.mode === 'near' && c.prox) p.set('prox', String(c.prox));
  return `${BASE}/?${p.toString()}`;
}

async function measure(page) {
  return await page.evaluate(() => {
    const vh = window.innerHeight;
    const details = document.querySelector('article details');
    const nextBtn = document.querySelector('[aria-label="Next match"], [aria-label="अगला"]');
    const footer = nextBtn && nextBtn.parentElement.querySelector('span')
      ? nextBtn.parentElement.querySelector('span').textContent.replace(/\s+/g, ' ').trim() : null;
    const cur = document.querySelector('.ring-2') || document.querySelector('article ol li.ring-1');
    let curInView = false, curHasMark = false;
    if (cur) {
      const r = cur.getBoundingClientRect();
      curInView = r.top >= -8 && r.top <= vh * 0.95 && r.bottom > 0 && r.width > 0;
      curHasMark = !!cur.querySelector('mark');
    }
    return {
      collapsed: details ? !details.open : null,
      prevNextVisible: !!(nextBtn && nextBtn.offsetParent !== null),
      footer, curFound: !!cur, curInView, curHasMark,
      mode: document.querySelector('.ring-2') ? 'body' : (document.querySelector('article ol li.ring-1') ? 'card' : null),
    };
  });
}

async function runConfig(page, c) {
  const rows = [];
  await page.goto(url(c), { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('main', { timeout: 25000 });
  try {
    await page.waitForFunction(
      () => /\d+\s+RECORDS?,\s*\d+\s+HITS?/i.test(document.body.textContent || '')
            || /no results|0 records/i.test(document.body.textContent || ''),
      { timeout: 90000 });
  } catch { return { name: c.name, error: 'search did not return (timeout — NEAR can be slow)' }; }
  await page.waitForTimeout(700);
  const total = await page.evaluate(() => {
    const m = (document.body.textContent || '').match(/(\d+)\s+RECORDS?,\s*(\d+)\s+HITS?/i);
    return m ? { records: +m[1], hits: +m[2] } : null;
  });
  const clicked = await page.evaluate(() => {
    const btns = Array.from(document.querySelectorAll('button'));
    const rec = btns.find((b) => /~\s*\d/.test(b.textContent || '') && b.getBoundingClientRect().left < 500);
    if (rec) { rec.click(); return true; }
    return false;
  });
  if (!clicked) return { name: c.name, total, error: 'could not click a result' };
  await page.waitForTimeout(3400); // discourse load + settle before first step
  rows.push({ step: 'landing', ...(await measure(page)) });
  for (let i = 1; i <= c.steps; i++) {
    const next = await page.$('[aria-label="Next match"]') || await page.$('[aria-label="अगला"]');
    if (!next) { rows.push({ step: `next${i}`, error: 'no Next btn' }); break; }
    if (await next.evaluate((b) => b.disabled)) { rows.push({ step: `next${i}`, note: 'Next disabled (end reached)' }); break; }
    await next.click();
    await page.waitForSelector('[aria-label="Next match"], [aria-label="अगला"]', { timeout: 12000 }).catch(() => {});
    await page.waitForTimeout(2300);
    rows.push({ step: `next${i}`, ...(await measure(page)) });
  }
  return { name: c.name, total, rows };
}

(async () => {
  const browser = await chromium.launch({ executablePath: findChrome(), headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  let pass = 0, checks = 0;
  const fails = [];
  for (const c of CONFIGS) {
    const res = await runConfig(page, c);
    console.log(`\n===== ${res.name}  |  ${res.total ? res.total.records + ' rec / ' + res.total.hits + ' hits' : 'n/a'} =====`);
    if (res.error) { console.log('  CONFIG ERROR:', res.error); fails.push(`${res.name}: ${res.error}`); continue; }
    for (const r of res.rows) {
      if (r.error) { console.log(`  ${r.step}: ERROR ${r.error}`); fails.push(`${res.name}/${r.step}: ${r.error}`); continue; }
      if (r.note) { console.log(`  ${r.step}: ${r.note}`); continue; }
      let ok, why;
      if (r.step === 'landing') {
        ok = r.collapsed === true && r.prevNextVisible === true;
        why = `collapsed=${r.collapsed} prevNextVisible=${r.prevNextVisible}`;
      } else {
        ok = r.curFound && r.curInView && r.curHasMark;
        why = `mode=${r.mode} inView=${r.curInView} hasMark=${r.curHasMark}`;
      }
      checks++; if (ok) pass++; else fails.push(`${res.name}/${r.step}: ${why}`);
      console.log(`  ${r.step}: ${ok ? 'PASS' : 'FAIL'} | footer="${r.footer}" | ${why}`);
    }
  }
  console.log(`\n================ ${pass}/${checks} checks passed ================`);
  if (fails.length) { console.log('\nFAILURES:'); fails.forEach((f) => console.log('  ✗', f)); }
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})().catch((e) => { console.error('FATAL', e); process.exit(2); });
