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
7. **FTS exact table highlight()** — production table is likely contentless; rebuild FTS index to restore server-side highlights in exact mode.
