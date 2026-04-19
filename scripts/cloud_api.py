from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel
import sys
import os
import json
from contextlib import asynccontextmanager

# Absolute path anchoring for portability
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(BASE_DIR)

from scripts.search import HybridSearcher
from scripts.openrouter_rag import ask_osho_stream

# Persistent searcher instance
searcher = None

@asynccontextmanager
async def lifespan(app: FastAPI):
    """
    Manages the lifecycle of the Wisdom Engine.
    Ensures the 1.3M paragraph index is loaded once and kept warm.
    """
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

class QueryRequest(BaseModel):
    query: str

@app.get("/health")
def health():
    """Confirms the engine is alive and the mind-map is warm."""
    return {
        "status": "present", 
        "engine": "Osho Speaks..", 
        "warm": searcher is not None,
        "index_size": "1.3M Fragments"
    }

@app.post("/ask")
async def ask(request: QueryRequest):
    """Legacy endpoint for non-streaming clients. Returns full synthesis at once."""
    try:
        if not searcher:
            raise HTTPException(status_code=503, detail="The Engine is still cold. Wait for index loading.")
        
        # We'll implementation a simple wait for non-streaming
        wisdom = ""
        context = searcher.search(request.query, n_results=10) # Higher context for scholarly depth
        async for chunk in ask_osho_stream(request.query, context):
            wisdom += chunk
        return {"wisdom": wisdom}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

@app.post("/stream")
async def stream_wisdom(request: QueryRequest):
    """Elite streaming endpoint for instant feedback."""
    if not searcher:
        raise HTTPException(status_code=503, detail="The Engine is still cold.")
    
    # Retrieve context once to avoid redundant searching during stream
    context_results = searcher.search(request.query, n_results=10)
    
    return StreamingResponse(
        ask_osho_stream(request.query, context_results),
        media_type="text/event-stream"
    )

if __name__ == "__main__":
    import uvicorn
    # Industrial-grade production server entry
    uvicorn.run(app, host="0.0.0.0", port=8000)
