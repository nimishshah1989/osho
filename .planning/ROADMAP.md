# Roadmap

## Milestone 1: The Foundation & Ingestion
Objective: Safely ingest the massive 1.14GB dataset without crashing memory, establishing the Database.

### Phase 1: Data Engineering
- [x] `1: write-schema` Plan & implement db/schema.sql.
- [x] `2: write-ingest` Plan & implement memory-efficient streaming CSV parser (ingest.py).
- [x] `3: write-processor` Plan & implement metadata normalizer and chunking logic.
- [x] `4: run-ingestion` Execute script to hydrate native SQLite Database.

## Milestone 2: Search & Intelligence
Objective: Setup hybrid search + RAG.

### Phase 2: Core Intelligence
- [ ] `1: setup-search` Hybrid search engine integration.
- [ ] `2: rag-engine` Context retrieval logic for "Ask Osho".
- [ ] `3: file-watcher` PDF dropzone ingestion.

## Milestone 3: "The Void" UI
Objective: World-class, Oxford-grade Frontend.

### Phase 3: Frontend Architecture
- [ ] `1: nextjs-scaffold` Setup Next.js 14 and custom tokens (dark mode, glassmorphism).
- [ ] `2: ui-components` Interactive Reader and Search interface.
- [ ] `3: visual-graphs` Topic Connection and timeline visuals.
