import sqlite3
import csv
import sys
import os
import re

# Increase CSV field size limit for massive text blocks
csv.field_size_limit(sys.maxsize)

DB_PATH = 'data/osho.db'
CSV_PATH = 'data/osho_all.csv'
SCHEMA_PATH = 'db/schema.sql'

def init_db():
    print("Initializing Database...")
    conn = sqlite3.connect(DB_PATH)

    # Read schema
    with open(SCHEMA_PATH, 'r', encoding='utf-8') as f:
        schema = f.read()

    # Execute schema
    conn.executescript(schema)
    conn.commit()
    return conn

def extract_location(text):
    """Attempt to extract location from the initial metadata header if available."""
    match = re.search(r'place:\s*(.*?)(?=\n|event page)', text, re.IGNORECASE)
    if match:
        return match.group(1).strip()
    return None

def ingest_data(conn):
    print("Starting Stream Ingestion...")
    cursor = conn.cursor()

    if not os.path.exists(CSV_PATH):
        print(f"Error: {CSV_PATH} not found.")
        return

    events_inserted = 0
    paragraphs_inserted = 0

    with open(CSV_PATH, 'r', encoding='utf-8', errors='replace') as f:
        reader = csv.DictReader(f)

        for row in reader:
            event_id = row.get('id')
            if not event_id:
                continue

            title = row.get('title', 'Unknown Title')
            date_val = row.get('time', '')
            language = row.get('language', 'Unknown')
            event_text = row.get('eventText', '')

            location = extract_location(event_text)

            # 1. Insert Event
            try:
                cursor.execute('''
                    INSERT OR IGNORE INTO events (id, title, date, location, language)
                    VALUES (?, ?, ?, ?, ?)
                ''', (event_id, title, date_val, location, language))
                events_inserted += 1
            except sqlite3.Error as e:
                print(f"Error inserting event {event_id}: {e}")
                continue

            # 2. Chunk Event Text into Paragraphs
            # Split by FileMaker's vertical tab (\x0b) export format
            # Sometimes there might be multiple \x0b or spaces, we split carefully
            raw_text = event_text.replace('\r', '\n').replace('\x0b', '\n')
            chunks = re.split(r'\n+', raw_text)

            paragraph_records = []
            seq = 0
            for chunk in chunks:
                chunk = chunk.strip()
                if not chunk:
                    continue
                paragraph_records.append((event_id, seq, chunk))
                seq += 1

            try:
                cursor.executemany('''
                    INSERT INTO paragraphs (event_id, sequence_number, content)
                    VALUES (?, ?, ?)
                ''', paragraph_records)
                paragraphs_inserted += len(paragraph_records)
            except sqlite3.Error as e:
                print(f"Error inserting paragraphs for event {event_id}: {e}")

            # Commit every 100 events to manage transaction memory gracefully
            if events_inserted % 100 == 0:
                conn.commit()
                print(f"Progress: {events_inserted} events ingested...")

    # Final commit
    conn.commit()
    print("\nIngestion Complete!")
    print(f"Total Events: {events_inserted}")
    print(f"Total Paragraphs: {paragraphs_inserted}")

def main():
    os.makedirs('data', exist_ok=True)
    conn = init_db()
    ingest_data(conn)
    conn.close()

if __name__ == '__main__':
    main()
