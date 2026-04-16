import sqlite3
import json
import os
import random
import math

# Paths
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DB_PATH = os.path.join(BASE_DIR, 'data/osho.db')
OUTPUT_PATH = os.path.join(BASE_DIR, 'frontend/public/nebula_data.json')

# Thematic Galaxies & Colors
GALAXIES = {
    "Zen": {"color": "#10b981", "keywords": ["zen", "bodhidharma", "tao", "no-mind"]},
    "Tantra": {"color": "#ef4444", "keywords": ["tantra", "sex", "yoga", "vigyan bhairav"]},
    "Sufism": {"color": "#8b5cf6", "keywords": ["sufi", "jalaluddin", "rumi", "kabir"]},
    "Meditation": {"color": "#f59e0b", "keywords": ["meditation", "silence", "vipassana", "awareness"]},
    "Love & Freedom": {"color": "#ec4899", "keywords": ["love", "freedom", "heart", "zorba"]},
    "Philosophy": {"color": "#3b82f6", "keywords": ["philosophy", "nietzsche", "socrates", "western"]},
    "Misc": {"color": "#94a3b8", "keywords": []}
}

def get_galaxy(title):
    title_lower = title.lower()
    for name, data in GALAXIES.items():
        if any(k in title_lower for k in data["keywords"]):
            return name
    return "Misc"

def generate_nebula_data():
    if not os.path.exists(DB_PATH):
        print(f"Error: Database not found at {DB_PATH}")
        return

    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    
    print("Extracting discourse DNA...")
    cursor.execute("SELECT id, title, date, location FROM events")
    rows = cursor.fetchall()
    
    nebula = []
    
    # Galaxy centers to create physical clusters in 3D space
    centers = {
        name: {
            "x": random.uniform(-50, 50),
            "y": random.uniform(-30, 30),
            "z": random.uniform(-50, 50)
        } for name in GALAXIES.keys()
    }

    for row in rows:
        event_id, title, date, location = row
        galaxy_name = get_galaxy(title)
        center = centers[galaxy_name]
        
        # Spread points around their galaxy center
        spread = 15 if galaxy_name != "Misc" else 60
        x = center["x"] + random.gauss(0, spread)
        y = center["y"] + random.gauss(0, spread)
        z = center["z"] + random.gauss(0, spread)
        
        nebula.append({
            "id": event_id,
            "title": title,
            "galaxy": galaxy_name,
            "color": GALAXIES[galaxy_name]["color"],
            "pos": [x, y, z],
            "date": date
        })
    
    print(f"Mapped {len(nebula)} points in the constellation.")
    
    os.makedirs(os.path.dirname(OUTPUT_PATH), exist_ok=True)
    with open(OUTPUT_PATH, 'w') as f:
        json.dump(nebula, f)
    
    conn.close()
    print(f"Success: Nebula data saved to {OUTPUT_PATH}")

if __name__ == "__main__":
    generate_nebula_data()
