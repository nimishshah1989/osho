# Osho Archives Search Engine

## What This Is

A production search engine and archive for Osho's complete discourses — ~75,000 paragraphs across ~10,000 events in English and Hindi. Live at **oshoarchives.com**.

## Two User Audiences

1. **Sannyasins worldwide** — search and read Osho's words verbatim, in English and Hindi, with exact-match and proximity search
2. **Archivists (Antar, Rudra, et al.)** — ingest new talks, fix metadata, cross-check results against OCTP (Osho Complete Text Program — the reference CD-ROM tool)

## Core Value

Faithful, fast, bilingual full-text search of the complete Osho corpus. The reference standard for archivists is OCTP (a 1994 CD-ROM running Folio Views). Our search semantics are reverse-engineered to match OCTP: record-level all-words, in-paragraph NEAR (N ≤ 100), exact mode, one hit per discourse.

## Stack

| Layer | Technology |
|-------|-----------|
| Frontend | Next.js 14 app router, TypeScript, Tailwind |
| Backend | FastAPI + raw sqlite3 (no ORM) |
| Search | SQLite FTS5 (porter stemming + unicode61 + custom Hindi tokenizer) |
| Hosting | E2E Networks VPS 164.52.223.241, Ubuntu 24.04 |
| CDN/TLS | Cloudflare (DNS + edge proxy, Cloudflare-only ingress) |
| Offline | PWA (sqlite-wasm + OPFS in web worker) + Electron desktop app |

## Key Pages

| Route | Purpose |
|-------|---------|
| `/` | Main search interface |
| `/archive` | Tree explorer — browse by year/series/place/theme |
| `/constellation` | Clustered visual by city × year × theme |
| `/read` | Full discourse reader |
| `/help` | Search guide + corpus version badge |
| `/downloadapp` | Offline / desktop setup |
| `/admin` | ADMIN_KEY-protected: ingest, edit, tag, batch update |

## Constraints

- DB lives only on the VPS (gitignored) — moved by rsync, never committed
- Cloudflare is the only allowed ingress — direct-IP requests return 403
- ADMIN_KEY must never be the default "osho-admin" in production
- Any change to the FTS5 tokenizer requires a full index rebuild (~5–10 min)
- Frontend and backend share the box — Next.js proxies to FastAPI over loopback, never the public IP
