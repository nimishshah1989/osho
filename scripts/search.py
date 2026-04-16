import os
import sys

# CRITICAL: Set environment variables BEFORE importing any ML libraries
# to prevent PermissionErrors in restricted environments like ~/.cache
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_PATH = os.path.join(BASE_DIR, 'data/cache')
os.environ['HF_HOME'] = CACHE_PATH
os.environ['TRANSFORMERS_CACHE'] = CACHE_PATH
os.makedirs(CACHE_PATH, exist_ok=True)

# Now we can safely import ML libraries
import sqlite3
import chromadb
import torch
from sentence_transformers import SentenceTransformer

DB_PATH = os.path.join(BASE_DIR, 'data/osho.db')
CHROMA_PATH = os.path.join(BASE_DIR, 'data/chromadb')

def get_device():
    if torch.backends.mps.is_available():
        return "mps"
    elif torch.cuda.is_available():
        return "cuda"
    return "cpu"

class HybridSearcher:
    def __init__(self):
        print(f"Loading search engine on {get_device()}...")
        # Force the model to load from local cache path
        self.model = SentenceTransformer("all-MiniLM-L6-v2", device=get_device(), cache_folder=CACHE_PATH)
        self.chroma_client = chromadb.PersistentClient(path=CHROMA_PATH)
        
        class CustomEF:
            def __init__(self, model):
                self.model = model
            def __call__(self, input):
                return self.model.encode(input).tolist()
        
        self.collection = self.chroma_client.get_collection(
            name="osho_paragraphs", 
            embedding_function=CustomEF(self.model)
        )
        self.conn = sqlite3.connect(DB_PATH)

    def search(self, query, n_results=5):
        print(f"Searching for: '{query}'")
        results = self.collection.query(
            query_texts=[query],
            n_results=n_results
        )
        
        search_results = []
        for i in range(len(results['ids'][0])):
            p_id = results['ids'][0][i]
            content = results['documents'][0][i]
            metadata = results['metadatas'][0][i]
            distance = results['distances'][0][i]
            
            cursor = self.conn.cursor()
            cursor.execute("SELECT title, date, location FROM events WHERE id = ?", (metadata['event_id'],))
            event_row = cursor.fetchone()
            
            search_results.append({
                "id": p_id,
                "content": content,
                "distance": distance,
                "event_title": event_row[0] if event_row else "Unknown",
                "event_date": event_row[1] if event_row else "Unknown",
                "event_location": event_row[2] if event_row else "Unknown",
                "sequence_number": metadata['sequence_number']
            })
        return search_results

    def close(self):
        self.conn.close()

if __name__ == "__main__":
    query = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "What is meditation?"
    searcher = HybridSearcher()
    results = searcher.search(query)
    for r in results:
        print(f"\n[{r['event_title']}]")
        print(f"Content: {r['content'][:200]}...")
    searcher.close()
