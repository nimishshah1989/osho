# State: Osho Archives Search Engine

**Status:** Production — Live at oshoarchives.com
**Last Updated:** 2026-06-18

---

## Production Environment

- **URL:** oshoarchives.com
- **Host:** E2E Networks VPS `164.52.223.241` (sponsor-owned, Ubuntu 24.04)
- **Proxy:** Cloudflare (DNS + edge TLS, Cloudflare-only ingress)
- **Frontend:** Next.js 14 app router — PM2 process `osho-frontend` on :3000
- **Backend:** FastAPI (uvicorn) — systemd `osho-backend.service` on 127.0.0.1:8000
- **Database:** SQLite FTS5 — `/home/osho/osho/data/osho.db` (~1.6 GB, **~1.3M paragraphs** (1,327,403 measured 2026-06-18), ~10K events). Earlier docs said "~75K" — that was a stale early estimate.
- **Edge:** HTTP/3 (QUIC) **disabled** at Cloudflare (Speed → Optimization) — fixes blank screens for users on networks that mishandle QUIC (confirmed O2/Telefónica Germany). Not a repo setting; re-check if blank-screen-on-one-ISP reports recur.

---

## Corpus Status

- **Version:** 2026-05-24 (visible on Help page)
- **Languages:** English + Hindi
- **Ingestion:** Self-service via `/admin` UI (no SSH needed) or CLI scripts
- **Next expected update:** Antar's monthly WordDB batch

---

## Recent Completed Work (PRs #85–109)

| PR | Summary | Date |
|----|---------|------|
| #85–87 | Sugit feedback batch 1: null crash, highlights, arrow nav, NEAR discourse hl, self-service ingestion, corpus version badge | 2026-05-22 |
| #88–90 | CLAUDE.md update, upload size limit 2 GB, Path/corpus_version fix | 2026-06-03/04 |
| #91 | Six bugs: title_search hl leak, viewport overflow, Hindi stopword crash, null crash, NEAR highlights, mixed-script queries | 2026-06-04 |
| #92 | `language=all` returning zero results | 2026-06-04 |
| #93 | Mixed-case "Or"/"And" rejected as FTS5 keywords | 2026-06-04 |
| #94 | Narrow NEAR (N < 100) false positives via cross-paragraph | 2026-06-04 |
| #95 | Sugit batch 2: @6/@11 NEAR=100 counts, @14/@16 exact highlights, @15 possessive apostrophe, @17 arrow key nav | 2026-06-06 |
| #96 | Hotfix: U+2018/U+2019 curly-quote SyntaxError crashed backend | 2026-06-06 |
| #97 | Hotfix: same curly-quote bug crashed frontend build | 2026-06-06 |
| #98 | @5: broad Hindi query (>500 events) → amber warning + trimmed response | 2026-06-08 |
| #99 | Sugit batch 3: re-enable cross-paragraph NEAR, @13 Hindi NEAR, @17-A/B/C discourse view fixes | 2026-06-12 |
| #100 | Fix stale FTS positions causing false NEAR matches; @6 exact 20→10 (OCTP: 10 ✓) | 2026-06-12 |
| #101 | Sugit UI batch @18–@36: filter **dropdowns**, hide Spelling control in exact-phrase mode, new **Time** sort, record typography, sannyas.wiki link, "discourses"→"records" | 2026-06-15 |
| #102 | Deploy hardening: `rm -rf .next` + homepage-asset verification (2026-06-16 blank-page incident) | 2026-06-16 |
| #103/#104 | Layout: 1600px shell, trimmed margins, compact search box, RANK on one line, taller panes | 2026-06-16 |
| `24eeb65` | Remove `/downloadapp` + `OfflineSetup.tsx` (@29 — desktop is the offline path); Help-page accuracy pass | 2026-06-17 |
| #105–#109 | **Search latency** (no result changes): drop duplicate hit text, defer `highlight()` to displayed hits, batch per-event lookup, SQL window-function counting. Worst case `मन की शांति` 8.4 s → 3.0 s; parity verified across 17 EN+HI cases | 2026-06-18 |
| ops | **HTTP/3 (QUIC) disabled at Cloudflare** — blank-screen fix for O2/Germany (not a repo change) | 2026-06-18 |

---

## Open Issues (as of 2026-06-18)

**High priority:**
1. **@3** — Intermittent seq=0 arrow-key nav on title-matched discourses. Believed fixed in PR #91; needs Sugit confirmation.

**Moderate priority:**
2. Hindi Enter-without-space submits Roman text (HindiInput stale closure)
3. Archive / Constellation / Help pages English-only (missing `t(...)` i18n)
4. Date range inputs don't auto-refresh on typing

**Minor / ops:**
5. Dead routes `/ask`, `/nebula`, `/zen-tree` → 404, should redirect to `/`
6. `total_hits` over-reports for narrow NEAR (N < 20)
7. Provisioning scripts not in repo (`02-setup-single-vps.sh`, `refresh-cloudflare-ips.sh`)
8. Stale FTS entries accumulate on each ingest (long-term code fix needed: also `DELETE FROM paragraphs_fts WHERE paragraph_id = ?` when paragraphs are removed). Short-term: run `build_fts.py` after each Antar batch. **Last full rebuild on VPS 2026-06-12** — `paragraphs_fts_exact` is fully populated and all then-stale entries cleared.
9. **Search latency floor** — broad cross-paragraph NEAR (3.6–10.8 s) and `मन की शांति` (~3 s) remain after #105–#109. Further gains need pagination (UX change) or a different FTS5-positions mechanism; deferred to keep results byte-identical to OCTP.

---

## Resolved this cycle (2026-06-12 → 2026-06-18)

- ~~**@11 / FTS exact-table rebuild on VPS**~~ — completed 2026-06-12; `paragraphs_fts_exact` now content-bearing.
- ~~**Blank page for some visitors**~~ — two distinct causes, both fixed: (a) an incomplete frontend build serving 400'd chunks → deploy script hardened (#102); (b) HTTP/3/QUIC failing on O2/Germany → HTTP/3 disabled at Cloudflare.
- ~~**Search "suddenly slow"**~~ — the OCTP-parity record-level search is heavy at ~1.3M paragraphs; optimized mechanically in #105–#109 with results held identical.
- ~~**"Missing tabs" reports**~~ — not a regression: the filter tab-buttons became dropdowns and the Spelling control is hidden in exact-phrase mode, both per Sugit's approved @18/@22/@23 (PR #101).
