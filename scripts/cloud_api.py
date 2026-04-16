from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import sys
import os
import json
from contextlib import asynccontextmanager

# Ensure absolute paths for cloud environment
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(BASE_DIR)

from scripts.search import HybridSearcher
from scripts.gemini_rag import ask_osho_stream

# Persistent searcher instance
searcher = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    global searcher
    print("Wisdom Engine: Loading 1.3M paragraph index into RAM...")
    searcher = HybridSearcher()
    print("Wisdom Engine: Warm and ready.")
    yield
    if searcher:
        searcher.close()

app = FastAPI(title="Osho Speaks Cloud API", lifespan=lifespan)

class QueryRequest(BaseModel):
    query: str

@app.get("/health")
def health():
    return {"status": "present", "engine": "Osho Speaks..", "warm": searcher is not None}

@app.post("/ask")
async def ask(request: QueryRequest):
    """Legacy endpoint for non-streaming clients"""
    try:
        if not searcher:
            raise HTTPException(status_code=503, detail="The Engine is still cold.")
        
        # We'll implementation a simple wait for non-streaming
        wisdom = ""
        async for chunk in ask_osho_stream(request.query, searcher):
            wisdom += chunk
        return {"wisdom": wisdom}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/stream")
async def stream_wisdom(request: QueryRequest):
    """Elite streaming endpoint for millisecond feedback"""
    if not searcher:
        raise HTTPException(status_code=503, detail="The Engine is still cold.")
    
    return StreamingResponse(
        ask_osho_stream(request.query, searcher),
        media_type="text/event-stream"
    )

@app.get("/hierarchy")
async def get_hierarchy():
    """Returns the structural mind-map of the entire archive"""
    try:
        import sqlite3
        conn = sqlite3.connect(os.path.join(BASE_DIR, 'data/osho.db'))
        cursor = conn.cursor()
        
        # Get Years -> Series -> Talks
        cursor.execute("""
            SELECT date, title FROM events 
            WHERE date IS NOT NULL AND date != 'Unknown'
            ORDER BY date ASC
        """)
        rows = cursor.fetchall()
        
        hierarchy = {}
        for date_str, title in rows:
            # Extract year from YYYY-MM-DD pattern
            year = date_str[:4] if len(date_str) >= 4 and date_str[:4].isdigit() else "Eternal"
            
            if year not in hierarchy:
                hierarchy[year] = {}
            
            # Use title prefix as 'Series' (e.g., 'A Rose Is a Rose Is a Rose ~ 01' -> 'A Rose Is a Rose Is a Rose')
            series = title.split(" ~ ")[0] if " ~ " in title else "Stand-alone"
            
            if series not in hierarchy[year]:
                hierarchy[year][series] = []
            
            hierarchy[year][series].append(title)
        
        conn.close()
        return hierarchy
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
