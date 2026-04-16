import sqlite3
import json
import os

DB_PATH = 'data/osho.db'
TOPICS_OUTPUT = 'data/topics.json'

# Common Osho themes for rule-based seeding
CORE_THEMES = {
    "Meditation": ["meditation", "silence", "vipassana", "witness", "no-mind"],
    "Zen": ["zen", "koan", "basui", "sosans", "bodhidharma", "lin-chi"],
    "Sufism": ["sufi", "jalaluddin", "rumi", "mevlevi"],
    "Taoism": ["tao", "lao tzu", "chuang tzu", "lieh tzu"],
    "Buddhism": ["buddha", "dhammapada", "heart sutra", "enlightenment"],
    "Love & Relationships": ["love", "relationship", "marriage", "sex", "tantra"],
    "Society & Rebellion": ["society", "politician", "rebellion", "revolution", "zorba"],
    "Life & Death": ["life", "death", "loneliness", "ego", "fear"]
}

def identify_topic(title, content_sample=""):
    title = title.lower()
    content_sample = content_sample.lower()
    
    for theme, keywords in CORE_THEMES.items():
        if any(kw in title for kw in keywords):
            return theme
        if any(kw in content_sample for kw in keywords):
            return theme
            
    return "The Unknown" # Default category

def extract_topics():
    print("Connecting to Database...")
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    print("Fetching discourse titles...")
    cursor.execute("SELECT id, title FROM events")
    events = cursor.fetchall()
    
    topic_map = {}
    
    for event_id, title in events:
        # Fetch a small sample of text from the discourse for better matching
        cursor.execute("SELECT content FROM paragraphs WHERE event_id = ? LIMIT 3", (event_id,))
        paragraphs = cursor.fetchall()
        content_sample = " ".join([p[0] for p in paragraphs])
        
        topic = identify_topic(title, content_sample)
        topic_map[event_id] = {
            "title": title,
            "topic": topic
        }
        
    print(f"Processed {len(topic_map)} discourses.")
    
    with open(TOPICS_OUTPUT, 'w', encoding='utf-8') as f:
        json.dump(topic_map, f, indent=2)
        
    print(f"Topic map saved to {TOPICS_OUTPUT}")
    conn.close()

if __name__ == "__main__":
    if not os.path.exists(DB_PATH):
        print(f"Error: {DB_PATH} not found.")
    else:
        extract_topics()
