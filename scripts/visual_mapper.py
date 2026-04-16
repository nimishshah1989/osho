import json
import random
import math
import os

TOPICS_FILE = 'data/topics.json'
COORDINATES_FILE = 'frontend/public/constellation_data.json'

# Center coordinates for each topic "Galaxy"
TOPIC_CENTERS = {
    "Meditation": (100, 0, 0),
    "Zen": (0, 100, 0),
    "Sufism": (0, 0, 100),
    "Taoism": (-100, 0, 0),
    "Buddhism": (0, -100, 0),
    "Love & Relationships": (0, 0, -100),
    "Society & Rebellion": (70, 70, 0),
    "Life & Death": (0, 70, 70),
    "The Unknown": (150, 150, 150)
}

def generate_constellation():
    if not os.path.exists(TOPICS_FILE):
        print(f"Error: {TOPICS_FILE} not found. Run topic_extractor.py first.")
        return

    with open(TOPICS_FILE, 'r') as f:
        topic_data = json.load(f)

    constellation = []
    
    print("Mapping discourses to 3D space...")
    for event_id, data in topic_data.items():
        topic = data['topic']
        center = TOPIC_CENTERS.get(topic, (0, 0, 0))
        
        # Spread discourses around the constellation center in a sphere
        radius = random.uniform(5, 40)
        phi = random.uniform(0, 2 * math.pi)
        theta = random.uniform(0, math.pi)
        
        x = center[0] + radius * math.sin(theta) * math.cos(phi)
        y = center[1] + radius * math.sin(theta) * math.sin(phi)
        z = center[2] + radius * math.cos(theta)
        
        constellation.append({
            "id": event_id,
            "title": data['title'],
            "topic": topic,
            "position": [round(x, 2), round(y, 2), round(z, 2)]
        })

    os.makedirs(os.path.dirname(COORDINATES_FILE), exist_ok=True)
    with open(COORDINATES_FILE, 'w') as f:
        json.dump(constellation, f)
        
    print(f"Generated {len(constellation)} coordinates in {COORDINATES_FILE}")

if __name__ == "__main__":
    generate_constellation()
