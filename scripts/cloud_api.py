from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import sys
import os
import json
import sqlite3
from collections import Counter
from contextlib import asynccontextmanager

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(BASE_DIR)

from scripts.search import HybridSearcher
from scripts.openrouter_rag import ask_osho_stream

DB_PATH = os.path.join(BASE_DIR, 'data/osho.db')

ALLOWED_ORIGINS = [
    o.strip()
    for o in os.getenv("ALLOWED_ORIGINS", "https://osho-zeta.vercel.app").split(",")
    if o.strip()
]

# Cluster palette reused across lenses
LENS_PALETTE = {
    "Meditation":    "#f59e0b",
    "Zen":           "#10b981",
    "Tantra":        "#ef4444",
    "Sufism":        "#8b5cf6",
    "Love":          "#ec4899",
    "Love & Freedom":"#ec4899",
    "Philosophy":    "#3b82f6",
    "Misc":          "#94a3b8",
    "Bombay":        "#60a5fa",
    "Poona I":       "#d4af37",
    "Rajneeshpuram": "#ef4444",
    "Poona II":      "#10b981",
    "Pune":          "#d4af37",
    "Kathmandu":     "#8b5cf6",
    "Oregon":        "#ef4444",
    "Unknown":       "#94a3b8",
}


def _palette(name: str) -> str:
    return LENS_PALETTE.get(name, "#94a3b8")


def _era_from_date(raw: str) -> str:
    year = (raw or "")[:4]
    if not year.isdigit():
        return "Unknown"
    y = int(year)
    if y < 1970:
        return "Bombay"
    if y < 1981:
        return "Poona I"
    if y < 1986:
        return "Rajneeshpuram"
    return "Poona II"


searcher = None


@asynccontextmanager
async def lifespan(app: FastAPI):
    global searcher
    try:
        print("Wisdom Engine: Loading discourse index into RAM...")
        searcher = HybridSearcher()
        print("Wisdom Engine: Warm and ready for scholarly synthesis.")
    except Exception as e:
        print(f"Wisdom Engine: Failed to ignite. Error: {str(e)}")
    yield
    if searcher:
        searcher.close()


app = FastAPI(title="Osho Wisdom Engine API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=ALLOWED_ORIGINS,
    allow_credentials=False,
    allow_methods=["GET", "POST"],
    allow_headers=["*"],
)


class QueryRequest(BaseModel):
    query: str


def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n"


@app.get("/health")
def health():
    return {
        "status": "present",
        "engine": "Osho Speaks..",
        "warm": searcher is not None,
        "index_size": "1.3M Fragments",
    }


@app.post("/ask")
async def ask(request: QueryRequest):
    if not searcher:
        raise HTTPException(status_code=503, detail="The Engine is still cold.")
    try:
        context = searcher.search(request.query, n_results=10)
        wisdom = ""
        async for chunk in ask_osho_stream(request.query, context):
            wisdom += chunk
        return {"wisdom": wisdom, "citations": _citations(context)}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))


def _citations(context):
    seen = set()
    out = []
    for r in context:
        key = (r.get("event_title"), r.get("event_date"))
        if key in seen:
            continue
        seen.add(key)
        out.append({
            "id": r.get("id"),
            "title": r.get("event_title"),
            "date": r.get("event_date"),
            "location": r.get("event_location"),
            "source_url": r.get("source_url"),
        })
    return out


@app.post("/stream")
async def stream_wisdom(request: QueryRequest):
    """SSE endpoint emitting event:wisdom chunks, event:citation entries, and a final event:retrieved event."""
    if not searcher:
        raise HTTPException(status_code=503, detail="The Engine is still cold.")

    context_results = searcher.search(request.query, n_results=10)

    async def event_stream():
        try:
            async for chunk in ask_osho_stream(request.query, context_results):
                if chunk:
                    yield _sse("wisdom", {"chunk": chunk})
            for c in _citations(context_results):
                yield _sse("citation", c)
            yield _sse("retrieved", {
                "ids": [r["id"] for r in context_results if r.get("id") is not None]
            })
            yield _sse("done", {"ok": True})
        except Exception as e:
            yield _sse("error", {"message": str(e)})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@app.get("/api/clusters")
def clusters(lens: str = "themes", limit: int = 20):
    """Cluster metadata per lens. Pulls from SQLite events table."""
    if not os.path.exists(DB_PATH):
        return {"lens": lens, "clusters": []}
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()

    if lens == "timeline":
        cur.execute("SELECT date FROM events WHERE date IS NOT NULL")
        buckets = Counter(_era_from_date(r["date"]) for r in cur.fetchall())
        order = ["Bombay", "Poona I", "Rajneeshpuram", "Poona II", "Unknown"]
        clusters_out = [
            {"name": name, "size": buckets[name], "color": _palette(name)}
            for name in order if buckets[name] > 0
        ]
    elif lens == "geography":
        cur.execute("SELECT location, COUNT(*) c FROM events WHERE location IS NOT NULL GROUP BY location ORDER BY c DESC LIMIT ?", (limit,))
        clusters_out = [
            {"name": r["location"] or "Unknown", "size": r["c"], "color": _palette(r["location"] or "Unknown")}
            for r in cur.fetchall()
        ]
    else:
        # Themes / Concepts — derived from event titles via lightweight keyword match
        keywords = {
            "Meditation": ["meditation", "dhyan", "silence"],
            "Zen": ["zen", "bodhidharma", "hsin hsin ming"],
            "Tantra": ["tantra", "vigyan bhairav"],
            "Sufism": ["sufi", "rumi"],
            "Love": ["love", "intimacy"],
            "Philosophy": ["philosoph", "heraclitus", "nietzsche"],
        }
        cur.execute("SELECT title FROM events")
        counts = Counter()
        for r in cur.fetchall():
            t = (r["title"] or "").lower()
            matched = False
            for theme, keys in keywords.items():
                if any(k in t for k in keys):
                    counts[theme] += 1
                    matched = True
                    break
            if not matched:
                counts["Misc"] += 1
        clusters_out = [
            {"name": name, "size": size, "color": _palette(name)}
            for name, size in counts.most_common(limit)
        ]

    conn.close()
    return {"lens": lens, "clusters": clusters_out}


@app.get("/api/particle/{pid}")
def particle(pid: str):
    """Full paragraph + neighbors for a given paragraph id."""
    if not os.path.exists(DB_PATH):
        raise HTTPException(status_code=404, detail="Particle store unavailable")
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    cur = conn.cursor()
    cur.execute("SELECT id, event_id, sequence_number, content FROM paragraphs WHERE id = ?", (pid,))
    row = cur.fetchone()
    if not row:
        conn.close()
        raise HTTPException(status_code=404, detail="Particle not found")

    cur.execute("SELECT title, date, location FROM events WHERE id = ?", (row["event_id"],))
    ev = cur.fetchone()

    cur.execute(
        "SELECT id, sequence_number, content FROM paragraphs WHERE event_id = ? AND sequence_number BETWEEN ? AND ? ORDER BY sequence_number",
        (row["event_id"], max(0, row["sequence_number"] - 1), row["sequence_number"] + 1),
    )
    context = [
        {"id": r["id"], "sequence_number": r["sequence_number"], "content": r["content"]}
        for r in cur.fetchall()
    ]
    conn.close()

    return {
        "id": row["id"],
        "content": row["content"],
        "sequence_number": row["sequence_number"],
        "event": {
            "id": row["event_id"],
            "title": ev["title"] if ev else None,
            "date": ev["date"] if ev else None,
            "location": ev["location"] if ev else None,
        },
        "context": context,
    }


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
