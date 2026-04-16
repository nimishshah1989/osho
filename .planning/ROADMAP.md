# Roadmap

## Milestone 1: The Foundation & Ingestion
Objective: Safely ingest the massive 1.14GB dataset without crashing memory, establishing the Database.

### Phase 1: Data Engineering
- [x] `1: write-schema` Plan & implement db/schema.sql.
- [x] `2: write-ingest` Plan & implement memory-efficient streaming CSV parser (ingest.py).
- [x] `3: write-processor` Plan & implement metadata normalizer and chunking logic.
- [x] `4: run-ingestion` Execute script to hydrate native SQLite Database.

## Milestone 4: The Visual Wisdom Engine (Oxford Standard)
Objective: Realize a world-class, high-performance scholarly portal with advanced semantic and structural visualizations.

### Phase 10: The Warm Brain (Performance Optimization)
- [ ] `1: persistent-index` Load ChromaDB and MinLM into long-running EC2 memory.
- [ ] `2: sse-streaming` Implement Server-Sent Events (SSE) for word-by-word streaming syntheses.
- [ ] `3: latency-audit` Target <300ms time-to-first-token.

### Phase 11: The Interstellar Nebula (WebGL Visualization)
- [ ] `1: semantic-clustering` Perform AI-driven categorization for meaningful cluster colors.
- [ ] `2: nebula-zoom` Build a high-performance WebGL/Canvas zoomable constellation map.
- [ ] `3: cluster-navigation` Link Nebula nodes to search context and source documents.

### Phase 12: The Library & Mind Map (Explorer)
- [ ] `1: tree-visualizer` Hierarchical mind-map (Year -> Series -> Talk).
- [ ] `2: source-citation` Reference-grade citations with links to books/articles.
- [ ] `3: mobile-spotsless` Comprehensive UI/UX audit for perfect mobile responsiveness.
