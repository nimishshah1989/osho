# Roadmap

## Completed ✅

### Foundation (PRs #1–84, through 2026-05-22)
- SQLite FTS5 search engine with porter stemming + Hindi unicode tokenizer
- Record-level all-words and NEAR search matching OCTP semantics
- Exact mode (no stemming) via `paragraphs_fts_exact` table
- BM25 ranking + hit-count multiplier
- FTS5 highlights with «» markers, frontend `<Highlighted>` component
- Devanagari query normalisation (NFC + nasal→anusvara), Hindi vowel-length OR variants
- Full discourse reader with arrow-key paragraph navigation
- Archive tree explorer (year/era/place/theme lenses)
- Constellation view (city × year × theme scatter)
- Offline PWA (sqlite-wasm + OPFS web worker — full TS port of the search engine)
- Desktop Electron app (bundled corpus, offline from launch)
- Nightly corpus publish workflow (`.zst` → `corpus-latest` GitHub Release)
- Self-service ingestion via `/admin` UI (no SSH): bulk `.docx` zip + structured batch update
- Corpus version badge on Help page
- Hindi + English i18n on main search page

### Sugit Feedback Batch 1 (PRs #85–87, 2026-05-22)
- Fixed null crash, missing top-card highlights, arrow nav halting on seq=0, NEAR over-highlighting, FTS keyword collision, self-service ingestion, corpus version badge

### Stability + Archivist Fixes (PRs #88–98, 2026-06-03 to 2026-06-08)
- Upload size limit raised to 2 GB
- `language=all` zero-results bug fixed
- Mixed-case "Or"/"And" treated as literals (not FTS5 operators)
- Narrow NEAR (N ≤ 100) uses in-paragraph FTS5, not cross-paragraph record-level
- Sugit batch 2: NEAR=100 exact counts, exact-mode discourse highlights, possessive apostrophe inflation, arrow-key discourse navigation
- Curly-quote SyntaxError hotfixes (backend + frontend)
- Broad Hindi query (>500 events) → amber warning + trimmed response, no NetworkError

### NEAR Accuracy + Discourse View (PRs #99–100, 2026-06-12)
- Re-enabled cross-paragraph NEAR for all N (PR #94's `dist_p > 100` gate was an overcorrection; OCTP does match across paragraph boundaries)
- Fixed stale FTS positions: paragraphs deleted during re-ingest leave ghost rows in `paragraphs_fts`; `seq_off.get(seq, 0)` was defaulting to 0 and creating false matches. Fix: skip `None` seqs. @6 NEAR=100: 20→10 ✓, @2 NEAR=20: 13→5 ✓, @11 NEAR=100: 2→1 ✓ (all match OCTP)
- FTS rebuild completed on VPS: `paragraphs_fts_exact` now fully populated; all stale entries cleared
- Discourse exact-phrase highlights now per-paragraph (was globally suppressed when any paragraph had backend markers)
- Arrow key navigation through discourse hits: → steps through matched paragraphs before advancing to next discourse
- NEAR proximity border box no longer shows context-only paragraphs — only actual hit paragraphs shown
- Hindi NEAR=100 cross-paragraph queries now work (@13: `Agyat Ki Or अंधकारपूर्ण` → 1, OCTP: 1 ✓)

### UI Batch + Speed + Incidents (PRs #101–#109 + ops, 2026-06-13 to 2026-06-18)
- **Sugit UI batch @18–@36 (PR #101):** filters rebuilt as compact dropdowns (`FilterSelect`); Spelling (Stemmed/Exact) control hidden in exact-phrase mode; new **Time** (chronological) sort across backend + offline engine + proxy; record typography (event-info block, sannyas.wiki title link, indents, italics, soft line breaks); "discourses"→"records". *(This is the "missing tabs" some users reported — tab-buttons became dropdowns + Spelling hides in phrase mode, both by request.)*
- **Layout (PRs #103/#104):** 1600px shell, trimmed left/right/bottom margins, compact search box, RANK header kept on one line, taller result panes — for more reading space.
- **`/downloadapp` removed (@29):** in-browser corpus-download UI + `OfflineSetup.tsx` deleted; desktop Electron app is the going-forward offline path. The TS search engine (`frontend/lib/search/`) is retained — the desktop build depends on it.
- **Deploy hardening (PR #102):** `scripts/deploy-frontend.sh` now builds from a clean `.next` and verifies every homepage `/_next/static` asset resolves — root-cause fix for the 2026-06-16 blank-page incident (incomplete build served HTML referencing chunks that 400'd; blank for fresh visitors, invisible to the old `'/'`-only healthcheck).
- **Search latency (PRs #105–#109, no result changes):** stopped shipping duplicate hit text, deferred FTS5 `highlight()` to displayed hits only, batched per-event lookups, and pushed all-words counting/selection into SQL window functions. Worst case `मन की शांति` 8.4 s → 3.0 s; `प्रेम ध्यान शांति` 4.0 s → 2.3 s. Every `total`/`hit-count` verified byte-identical to OCTP across 17 EN+HI parity cases (`scripts/tests/test_search.py`, `engine.test.ts`).
- **HTTP/3 disabled at Cloudflare (ops):** QUIC was causing blank screens for an O2/Telefónica Germany user; disabled via Speed → Optimization so all clients stay on TCP. Not a repo change.

---

## Active — Open Issues

See `.planning/STATE.md` for the current open-issues list.

---

## Future Considerations (not scheduled)

These are ideas that have come up but have no committed timeline:

1. **Stop-word–aware NEAR distance** — would make NEAR=20 give the same count as OCTP for tight queries (currently FTS5 counts all tokens; OCTP skips articles/prepositions). ~2 weeks of work.
2. **Hindi i18n for Archive / Constellation / Help** — all currently English-only; needs `t(...)` wrappers + Hindi strings.
3. **Dead route redirects** — `/ask`, `/nebula`, `/zen-tree` return 404; should 301 to `/`.
4. **Date range auto-refresh** — currently requires explicit submit after typing.
5. **HindiInput stale closure** — Enter without space submits Roman text.
6. **Provisioning scripts in repo** — `02-setup-single-vps.sh` and `refresh-cloudflare-ips.sh` exist only on the VPS.
7. **Search latency below the parity floor** — broad cross-paragraph NEAR (3.6–10.8 s) and `मन की शांति` (~3 s) survive the #105–#109 optimizations. Going lower means either result-paginating the record-level scan (a UX change) or maintaining our own FTS5-position index instead of calling `highlight()`. Deferred because every option risks diverging from OCTP, and parity is the contract.
8. ~~**FTS exact table highlight()**~~ — completed 2026-06-12: FTS rebuilt on VPS, `paragraphs_fts_exact` now content-bearing.
