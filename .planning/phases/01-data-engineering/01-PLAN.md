# Phase 1: Data Engineering Plan

**Objective:** Safely ingest the massive 1.14GB dataset without crashing memory, establishing the Database.

## Step 1: Write Schema (`db/schema.sql`)
1. Create `db/schema.sql` defining an optimized SQLite schema.
2. Tables needed (based on FileMaker data shape for text content):
   - `documents` (id, title, source, metadata)
   - `chunks` (id, document_id, content, chunk_index, created_at)
3. Ensure adequate foreign key constraints and indices for fast retrieval.

## Step 2: Write Ingest Script (`scripts/ingest.py`)
1. Initialize `scripts/ingest.py`.
2. Use Python's built-in `csv` module with a streaming approach (generator pattern) to avoid loading the 1.14GB file into memory.
3. Connect to SQLite using Python's `sqlite3` and use `executemany` for batch inserts.

## Step 3: Write Processor & Normalizer (`scripts/processor.py`)
1. Create `scripts/processor.py` to handle metadata normalization and chunking of text.
2. Define a basic chunking logic (e.g., split by paragraphs or max tokens/characters).
3. Integrate the processor stream with the ingestion script.

## Step 4: Run Ingestion (`run-ingestion`)
1. Set up a quick dry-run test with a sample file to ensure memory stability.
2. Execute the ingestion script against the main dataset or provide instructions for the user to run it if the dataset requires specific paths.
