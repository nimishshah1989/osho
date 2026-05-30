/**
 * Packaging guard: every file the app `require()`s at runtime must be
 * listed in electron-builder.yml's `files:` allowlist, or it won't be
 * inside the installed app and the user gets "Cannot find module './x'"
 * on launch (exactly the 2026-05-30 regression after server.js was
 * extracted from main.js but not added to `files:`).
 *
 * Walks relative requires transitively from the electron entry (main.js)
 * and fails if any referenced local module isn't packaged. node_modules
 * deps are ignored — electron-builder bundles those automatically.
 *
 * Run: npm run check:bundle
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const yaml = require('js-yaml'); // ships with electron-builder
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP = path.join(HERE, '..');

const builder = yaml.load(readFileSync(path.join(DESKTOP, 'electron-builder.yml'), 'utf8'));
const pkg = JSON.parse(readFileSync(path.join(DESKTOP, 'package.json'), 'utf8'));
const filesList = builder.files || [];

// True if a desktop-root-relative file (e.g. "server.js") is covered by
// the `files:` allowlist — either listed explicitly or under a glob.
function isPackaged(relFile) {
  return filesList.some((entry) => {
    if (entry === relFile) return true;
    if (entry.endsWith('/**/*')) {
      const dir = entry.slice(0, -'/**/*'.length);
      return relFile.startsWith(dir + '/');
    }
    return false;
  });
}

const RELATIVE_REQUIRE = /require\(\s*['"](\.\.?\/[^'"]+)['"]\s*\)/g;

const problems = [];
const seen = new Set();
const queue = [pkg.main || 'main.js']; // electron entry point

while (queue.length) {
  const rel = queue.shift();
  if (seen.has(rel)) continue;
  seen.add(rel);

  if (rel !== (pkg.main || 'main.js') && !isPackaged(rel)) {
    problems.push(rel);
  }

  let src;
  try {
    src = readFileSync(path.join(DESKTOP, rel), 'utf8');
  } catch {
    continue; // unreadable (shouldn't happen) — the isPackaged check above already flags it
  }
  for (const m of src.matchAll(RELATIVE_REQUIRE)) {
    let target = path.normalize(path.join(path.dirname(rel), m[1]));
    if (!path.extname(target)) target += '.js';
    queue.push(target.split(path.sep).join('/'));
  }
}

if (problems.length) {
  console.error('FAIL: these local modules are require()d at runtime but are NOT in');
  console.error('electron-builder.yml `files:`, so they would be missing from the installer:');
  for (const p of problems) console.error('  - ' + p);
  console.error('\nAdd each to the `files:` list in desktop/electron-builder.yml.');
  process.exit(1);
}

console.log('check:bundle OK — all runtime-required local modules are packaged:');
for (const f of [...seen].filter((f) => f.endsWith('.js'))) console.log('  - ' + f);
