-- db/schema.sql
-- High-performance schema for storing Osho discourses and chunked paragraphs

CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,           -- Unique identifier for the discourse
    title TEXT NOT NULL,           -- e.g., "The Mustard Seed"
    date TEXT,                     -- The date the discourse was given (e.g. YYYY-MM-DD or raw string)
    location TEXT,                 -- e.g., "Pune", "Rajneeshpuram"
    language TEXT,                 -- "English" or "Hindi"
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS paragraphs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL,
    sequence_number INTEGER NOT NULL,  -- To preserve the order of the discourse
    content TEXT NOT NULL,             -- The actual chunked paragraph text
    is_embedded BOOLEAN DEFAULT 0,     -- Flag for Vector DB Sync
    FOREIGN KEY (event_id) REFERENCES events (id)
);

-- Optimize for multidimensional filtering
CREATE INDEX IF NOT EXISTS idx_events_date ON events(date);
CREATE INDEX IF NOT EXISTS idx_events_location ON events(location);
CREATE INDEX IF NOT EXISTS idx_events_language ON events(language);

-- Optimize for sequential reading
CREATE INDEX IF NOT EXISTS idx_paragraphs_event_seq ON paragraphs(event_id, sequence_number);
