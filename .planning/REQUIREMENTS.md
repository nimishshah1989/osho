# Requirements

## Search Behaviour (reference: OCTP / Folio Views)

The archivist reference tool is OCTP (Osho Complete Text Program, 1994 CD-ROM, Folio Views engine). Our search must match its semantics:

| Behaviour | Spec |
|-----------|------|
| All-words | Discourse qualifies if every search word appears anywhere in its text (record-level AND) |
| NEAR (any N) | Cross-paragraph record-level proximity (`_augment_near_cross_paragraph`). FTS5 in-paragraph NEAR is used for initial candidate retrieval; the record-level window check is always applied. |
| Exact mode | No stemming, no variant matching — `paragraphs_fts_exact` table |
| Hit count | All-words: number of matched paragraphs; NEAR: 1 per discourse |
| One result per discourse | Deduplication at event level |

Known gap vs OCTP: FTS5 counts all tokens (articles, prepositions) in NEAR distance; Folio Views likely counted only content words. Effect: our NEAR=28 ≈ OCTP NEAR=20 for English queries.

## FTS5 Tokenizer (non-negotiable)

```sql
tokenize = "porter unicode61 remove_diacritics 1 categories 'L* N* Co Mn Mc'"
```

- `porter` — English stemming. Hindi unaffected.
- `remove_diacritics 1` — strips Latin combining marks. **Never use 2** — destroys Devanagari matras.
- `categories 'L* N* Co Mn Mc'` — includes Mn (virama, anusvara, nukta) and Mc (vowel matras, visarga). Without Mn/Mc, every Hindi word splits at every matra/virama → false matches.

Any tokenizer change requires full index rebuild on VPS (~5–10 min).

**Index maintenance:** Paragraphs deleted during re-ingest leave stale rows in `paragraphs_fts` / `paragraphs_fts_exact`. Stale rows with positions that default to 0 create false NEAR matches. Long-term fix: `DELETE FROM paragraphs_fts WHERE paragraph_id = ?` when removing paragraphs. Short-term: run `python3 scripts/build_fts.py` after each Antar batch (clears all stale entries, ~5–10 min). Last rebuild: 2026-06-12.

## Devanagari Normalisation (must stay in sync)

Two copies — must always be identical:
- `scripts/build_fts.py` → `normalize_devanagari` (index-time)
- `scripts/cloud_api.py` → `_normalize_devanagari` (query-time)

Applies NFC + collapses nasal-consonant + virama → anusvara so `अनन्त` and `अनंत` match.

## Security

- `ADMIN_KEY` env var — never the default `"osho-admin"` in production. Backend hard-fails on startup if `OSHO_ENV=production` and key is default/missing.
- CORS: `ALLOWED_ORIGINS` env var (default `https://oshoarchives.com`)
- All admin endpoints require `x-admin-key` header matching `ADMIN_KEY`
- Cloudflare-only ingress — `cloudflare-allow.conf` allowlist in nginx; direct-IP → 403

## Code Conventions

- **Frontend:** Next.js 14 app router, TypeScript, Tailwind. All user-visible strings via `t(...)` from `lib/i18n.tsx`. No inline `'भाषा' : 'Lang'` literals in components.
- **Backend:** FastAPI + raw sqlite3. Parameterised queries always. Never f-string SQL except `where_extra` (built from trusted column names only).
- **Devanagari content/titles** must pass through `_normalize_devanagari` before insert or FTS match.
- **Offline TS engine** (`frontend/lib/search/`) must stay behaviour-compatible with `scripts/cloud_api.py` — tokenizer, normalisation, BM25 ranking, NEAR semantics are all duplicated and tested in `frontend/lib/search/__tests__/`.

## Data

- DB lives only on the VPS (`/home/osho/osho/data/osho.db`) — gitignored, moved by rsync
- Corpus version stored in `corpus_meta` table, exposed via `/api/version`, shown on Help page
- Offline corpus: compressed `.zst` published nightly to `corpus-latest` GitHub Release asset
