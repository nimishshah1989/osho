# Core Requirements

## Source Data Constraints
- **Volume:** Massive 1.14GB dataset.
- **Goal:** Safely ingest without crashing memory. Needs highly memory-efficient streaming CSV ingestion.
- **Structure:** FileMaker Pro extracted data (often containing un-normalized metadata or varied formats).
- **Target:** Native SQLite Database to act as Truth source.

## Search Capabilities (Milestone 2)
- Hybrid search is required (combining lexical and vector search).
- RAG (Retrieval-Augmented Generation) Context engine for "Ask Osho".
- Ability to parse and watch PDF dropzones for continuous metadata insertion.

## UX / UI Constraints (Milestone 3)
- "The Void" UI: Must be an Oxford-grade Frontend.
- Framework: Next.js 14.
- Aesthetics: World-class, immersive. Must use custom tokens emphasizing dark mode, glassmorphism, and minimal cognitive load.
- Core Interactions: Interactive Reader, Search interface, Visual topic connection graphs.
