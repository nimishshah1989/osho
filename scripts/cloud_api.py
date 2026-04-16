from fastapi import FastAPI, HTTPException
from pydantic import BaseModel
import sys
import os

# Ensure absolute paths for cloud environment
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.append(BASE_DIR)

from scripts.search import HybridSearcher
from scripts.gemini_rag import ask_osho

app = FastAPI(title="Osho Speaks Cloud API")

class QueryRequest(BaseModel):
    query: str

@app.get("/health")
def health():
    return {"status": "present", "engine": "Osho Speaks.."}

@app.post("/ask")
async def ask(request: QueryRequest):
    try:
        wisdom = ask_osho(request.query)
        return {"wisdom": wisdom}
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)
