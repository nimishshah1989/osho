import sqlite3
import chromadb
from chromadb.utils import embedding_functions
import os

DB_PATH = 'data/osho.db'
CHROMA_PATH = 'data/chromadb'
CACHE_PATH = 'data/cache'
BATCH_SIZE = 1000

# Redirect HuggingFace cache to project directory to avoid permission issues in ~/.cache
os.environ['HF_HOME'] = CACHE_PATH
os.environ['TRANSFORMERS_CACHE'] = CACHE_PATH

def get_unembedded_paragraphs(conn, limit=BATCH_SIZE):
    cursor = conn.cursor()
    cursor.execute('''
        SELECT id, content, event_id, sequence_number 
        FROM paragraphs 
        WHERE is_embedded = 0 
        LIMIT ?
    ''', (limit,))
    return cursor.fetchall()

def mark_as_embedded(conn, ids):
    cursor = conn.cursor()
    cursor.executemany('''
        UPDATE paragraphs SET is_embedded = 1 WHERE id = ?
    ''', [(i,) for i in ids])
    conn.commit()

def main():
    print("Checking for hardware acceleration...")
    import torch
    device = "cpu"
    if torch.backends.mps.is_available():
        device = "mps"
    elif torch.cuda.is_available():
        device = "cuda"
    print(f"Using device: {device}")

    print("Initializing ChromaDB and Embedding model...")
    os.makedirs(CHROMA_PATH, exist_ok=True)
    
    # We use MiniLM locally because it's fast and we have 1.3 million vectors to embed
    # Support for device mapping in sentence_transformer_ef is limited, 
    # so we manually load the model to ensure it uses the GPU.
    from sentence_transformers import SentenceTransformer
    model = SentenceTransformer("all-MiniLM-L6-v2", device=device)
    
    # Custom embedding function class to match ChromaDB's expected signature
    class CustomEF:
        def __call__(self, input):
            return model.encode(input).tolist()

    chroma_client = chromadb.PersistentClient(path=CHROMA_PATH)
    collection = chroma_client.get_or_create_collection(
        name="osho_paragraphs", 
        embedding_function=CustomEF()
    )

    print("Connecting to SQLite...")
    conn = sqlite3.connect(DB_PATH)

    total_embedded = 0
    try:
        while True:
            rows = get_unembedded_paragraphs(conn, BATCH_SIZE)
            if not rows:
                print("All paragraphs have been embedded!")
                break
                
            ids = []
            documents = []
            metadatas = []
            
            for row in rows:
                p_id, content, event_id, seq_num = row
                # We store paragraph ID as a string for ChromaDB
                ids.append(str(p_id))
                documents.append(content)
                metadatas.append({
                    "event_id": event_id,
                    "sequence_number": seq_num,
                    "sql_id": p_id
                })
            
            print(f"Embedding batch of {len(documents)} paragraphs...")
            collection.add(
                documents=documents,
                metadatas=metadatas,
                ids=ids
            )
            
            mark_as_embedded(conn, [int(i) for i in ids])
            total_embedded += len(ids)
            print(f"Successfully embedded {total_embedded} total paragraphs.")
            
    except KeyboardInterrupt:
        print("\nInterrupted by user. Progress has been saved.")
    finally:
        conn.close()

if __name__ == "__main__":
    main()
