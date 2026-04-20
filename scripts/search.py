import os
import sys

# CRITICAL: Set environment variables BEFORE importing any ML libraries
# to prevent PermissionErrors in restricted environments like ~/.cache
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CACHE_PATH = os.path.join(BASE_DIR, 'data/cache')
os.environ['HF_HOME'] = CACHE_PATH
os.environ['TRANSFORMERS_CACHE'] = CACHE_PATH
os.makedirs(CACHE_PATH, exist_ok=True)

import sqlite3
import time
import numpy as np
import torch
from sentence_transformers import SentenceTransformer

DB_PATH = os.path.join(BASE_DIR, 'data/osho.db')
CHROMA_PATH = os.path.join(BASE_DIR, 'data/chromadb')
FAISS_DIR = os.path.join(BASE_DIR, 'data/faiss')
FAISS_INDEX_PATH = os.path.join(FAISS_DIR, 'index.faiss')
FAISS_META_PATH = os.path.join(FAISS_DIR, 'meta.sqlite')


def get_device():
    if torch.backends.mps.is_available():
        return "mps"
    elif torch.cuda.is_available():
        return "cuda"
    return "cpu"


class HybridSearcher:
    def __init__(self):
        print(f"Loading search engine on {get_device()}...", flush=True)
        self.model = SentenceTransformer(
            "all-MiniLM-L6-v2", device=get_device(), cache_folder=CACHE_PATH
        )
        self.conn = sqlite3.connect(DB_PATH)

        # Prefer the RAM-resident FAISS index; fall back to ChromaDB if the
        # build hasn't been run yet on this host.
        self.backend = None
        if os.path.exists(FAISS_INDEX_PATH) and os.path.exists(FAISS_META_PATH):
            self._load_faiss()
        else:
            self._load_chroma()

    def _load_faiss(self):
        import faiss
        t0 = time.perf_counter()
        self.faiss_index = faiss.read_index(FAISS_INDEX_PATH)
        self.meta_conn = sqlite3.connect(FAISS_META_PATH, check_same_thread=False)
        self.backend = 'faiss'
        print(
            f"FAISS loaded: {self.faiss_index.ntotal:,} vectors "
            f"in {int((time.perf_counter() - t0) * 1000)}ms",
            flush=True,
        )

    def _load_chroma(self):
        import chromadb
        from chromadb.utils.embedding_functions import SentenceTransformerEmbeddingFunction

        print("FAISS index not found — falling back to ChromaDB (slow).", flush=True)
        self.chroma_client = chromadb.PersistentClient(path=CHROMA_PATH)
        self.embedding_function = SentenceTransformerEmbeddingFunction(
            model_name="all-MiniLM-L6-v2",
            device=get_device(),
            cache_folder=CACHE_PATH,
        )
        self.collection = self.chroma_client.get_collection(
            name="osho_paragraphs", embedding_function=self.embedding_function
        )
        self.backend = 'chroma'

    def warmup(self):
        """FAISS is already in RAM after load; this just confirms round-trip."""
        t0 = time.perf_counter()
        try:
            self.search("warmup", n_results=1)
            print(
                f"Wisdom Engine: {self.backend} warmed in "
                f"{int((time.perf_counter() - t0) * 1000)}ms",
                flush=True,
            )
        except Exception as e:
            print(f"Wisdom Engine: warmup skipped ({e})", flush=True)

    def search(self, query, n_results=5):
        print(f"Searching for: '{query}'", flush=True)
        t0 = time.perf_counter()
        emb = self.model.encode([query], show_progress_bar=False).astype('float32')
        embed_ms = int((time.perf_counter() - t0) * 1000)

        t1 = time.perf_counter()
        if self.backend == 'faiss':
            hits = self._search_faiss(emb, n_results)
        else:
            hits = self._search_chroma(emb, n_results)
        query_ms = int((time.perf_counter() - t1) * 1000)
        print(f"[search] backend={self.backend} embed={embed_ms}ms query={query_ms}ms", flush=True)

        # Join with events table for titles / dates / locations
        cursor = self.conn.cursor()
        out = []
        for h in hits:
            cursor.execute(
                "SELECT title, date, location FROM events WHERE id = ?",
                (h['event_id'],),
            )
            ev = cursor.fetchone()
            title = ev[0] if ev else "Unknown"
            out.append({
                "id": h['p_id'],
                "event_id": h['event_id'],
                "content": h['content'],
                "distance": h['distance'],
                "event_title": title,
                "event_date": ev[1] if ev else "Unknown",
                "event_location": ev[2] if ev else "Unknown",
                "sequence_number": h['sequence_number'],
                "source_url": (
                    f"https://www.google.com/search?q=Osho+{title.replace(' ', '+')}"
                    if ev else None
                ),
            })
        return out

    def _search_faiss(self, emb, n_results):
        import faiss
        faiss.normalize_L2(emb)
        scores, idxs = self.faiss_index.search(emb, n_results)
        rows = idxs[0].tolist()
        placeholders = ",".join("?" * len(rows))
        cur = self.meta_conn.cursor()
        cur.execute(
            f"SELECT row_id, p_id, event_id, sequence_number, content "
            f"FROM meta WHERE row_id IN ({placeholders})",
            rows,
        )
        by_row = {r[0]: r for r in cur.fetchall()}
        hits = []
        for pos, row_id in enumerate(rows):
            if row_id not in by_row:
                continue
            _, p_id, event_id, seq, content = by_row[row_id]
            hits.append({
                'p_id': p_id,
                'event_id': event_id,
                'sequence_number': seq,
                'content': content,
                # FAISS IP on normalized vectors = cosine similarity ∈ [-1,1].
                # Convert to "distance" so downstream code doesn't care.
                'distance': float(1.0 - scores[0][pos]),
            })
        return hits

    def _search_chroma(self, emb, n_results):
        results = self.collection.query(
            query_embeddings=emb.tolist(), n_results=n_results
        )
        hits = []
        for i in range(len(results['ids'][0])):
            md = results['metadatas'][0][i]
            hits.append({
                'p_id': results['ids'][0][i],
                'event_id': md['event_id'],
                'sequence_number': md['sequence_number'],
                'content': results['documents'][0][i],
                'distance': results['distances'][0][i],
            })
        return hits

    def close(self):
        self.conn.close()
        if getattr(self, 'meta_conn', None):
            self.meta_conn.close()


if __name__ == "__main__":
    query = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "What is meditation?"
    searcher = HybridSearcher()
    results = searcher.search(query)
    for r in results:
        print(f"\n[{r['event_title']}]")
        print(f"Content: {r['content'][:200]}...")
    searcher.close()
