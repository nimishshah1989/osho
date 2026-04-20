"""One-time: extract all vectors + metadata from ChromaDB into an in-memory
FAISS index and a sqlite sidecar. Run once on the machine that has
data/chromadb/; the runtime engine then loads data/faiss/ and never touches
Chroma again.

Usage:
    python3 scripts/build_faiss.py
Produces:
    data/faiss/index.faiss
    data/faiss/meta.sqlite   (row_id -> p_id, event_id, sequence_number, content)
"""
import os
import sqlite3
import time

import chromadb
import faiss
import numpy as np

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CHROMA_PATH = os.path.join(BASE_DIR, 'data/chromadb')
OUT_DIR = os.path.join(BASE_DIR, 'data/faiss')
os.makedirs(OUT_DIR, exist_ok=True)
INDEX_PATH = os.path.join(OUT_DIR, 'index.faiss')
META_PATH = os.path.join(OUT_DIR, 'meta.sqlite')

BATCH = 5000


def build():
    client = chromadb.PersistentClient(path=CHROMA_PATH)
    col = client.get_collection(name='osho_paragraphs')
    total = col.count()
    print(f"Exporting {total:,} vectors from ChromaDB...")

    if os.path.exists(META_PATH):
        os.remove(META_PATH)
    meta_conn = sqlite3.connect(META_PATH)
    meta_conn.execute(
        "CREATE TABLE meta (row_id INTEGER PRIMARY KEY, p_id TEXT, event_id TEXT, sequence_number INTEGER, content TEXT)"
    )
    meta_conn.execute("CREATE INDEX idx_meta_event ON meta(event_id)")

    index = None
    row_id = 0
    t0 = time.perf_counter()
    for offset in range(0, total, BATCH):
        batch = col.get(
            limit=BATCH,
            offset=offset,
            include=['embeddings', 'metadatas', 'documents'],
        )
        embs = np.asarray(batch['embeddings'], dtype=np.float32)
        if embs.size == 0:
            break
        faiss.normalize_L2(embs)  # cosine similarity via inner product
        if index is None:
            dim = embs.shape[1]
            index = faiss.IndexFlatIP(dim)
            print(f"Created IndexFlatIP dim={dim}")
        index.add(embs)

        rows = []
        for p_id, md, doc in zip(batch['ids'], batch['metadatas'], batch['documents']):
            rows.append(
                (row_id, p_id, md.get('event_id'), md.get('sequence_number'), doc)
            )
            row_id += 1
        meta_conn.executemany(
            "INSERT INTO meta (row_id, p_id, event_id, sequence_number, content) VALUES (?,?,?,?,?)",
            rows,
        )
        meta_conn.commit()

        pct = (row_id / total) * 100 if total else 100
        elapsed = time.perf_counter() - t0
        print(f"  {row_id:,}/{total:,} ({pct:.1f}%) — {elapsed:.1f}s elapsed", flush=True)

    meta_conn.close()
    faiss.write_index(index, INDEX_PATH)
    print(f"Done in {time.perf_counter() - t0:.1f}s")
    print(f"  index: {INDEX_PATH}  ({index.ntotal:,} vectors)")
    print(f"  meta:  {META_PATH}")


if __name__ == '__main__':
    build()
