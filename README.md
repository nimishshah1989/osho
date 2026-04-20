# Osho Wisdom Engine

A high-performance, scholarly-grade "Warm Brain" engine designed to synthesize Osho's teachings with sub-2s latency and robust multi-cloud resilience.

## Architecture

This project uses a **Split-Cloud Architecture**:
1.  **Frontend**: Deployed on **Vercel** ([https://osho-zeta.vercel.app](https://osho-zeta.vercel.app)). It serves as a zero-noise, extremist minimalist interface.
2.  **Backend**: Deployed on **AWS EC2** (`13.206.34.214`). It hosts the 1.3M paragraph ChromaDB index and the FastAPI streaming engine.

### The Connectivity Link
The frontend proxies requests to the backend via `frontend/app/api/ask/route.ts`. 
- **Endpoint**: `http://13.206.34.214:8000/stream` (SSE Events).

## Deployment & Portability

### 1. Environment Configuration
The engine requires a `.env` file in the root directory (or `/home/ubuntu/osho-speaks/.env`) with:
```env
GOOGLE_API_KEY='your_aistudio_key'  # Primary Engine (1500 req/day free)
OPENROUTER_API_KEY='your_api_key'  # Resilient Failover Engine
```

### 2. Backend Setup (EC2/Ubuntu)
```bash
# Clone the repository
git clone <repo_url>
cd osho-wisdom-engine

# Initialize Virtual Environment
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
```

You also need the 1.3M-paragraph corpus. These files aren't in git:
- `data/osho.db`       — SQLite with `events` + `paragraphs`
- `data/chromadb/`     — ChromaDB persistent store
rsync them onto the box before the next step.

### 3. Build the RAM-resident FAISS index (one-time)
Retrieval runs out of an in-memory FAISS index instead of disk-backed
ChromaDB — the difference is ~22s vs ~100ms per query. Build it once per
host:
```bash
python3 scripts/build_faiss.py
```
This reads `data/chromadb/` and writes `data/faiss/index.faiss` +
`data/faiss/meta.sqlite` (~2GB RAM at runtime). If these files are
missing, `HybridSearcher` silently falls back to ChromaDB.

### 4. Start the Engine
```bash
sudo nohup ./.venv/bin/python3 -u -m uvicorn scripts.cloud_api:app \
  --host 0.0.0.0 --port 8000 > backend.log 2>&1 &
```
`-u` keeps Python stdout unbuffered so `tail -f backend.log` shows
timing lines (`[search] backend=faiss embed=Xms query=Yms`) in real time.

## Resilience Logic (Elite Bridge)
The `scripts/openrouter_rag.py` implements a **Triple-Failover** system:
- **Level 1**: Direct Google Gemini 1.5 Flash (Bypasses rate limits).
- **Level 2**: NVIDIA Nemotron-3 Super (Failover for Google outages).
- **Level 3**: OpenAI GPT-OSS + OpenRouter Auto-Fallback.

## Scholarly Guardrails
The engine is strictly instructed to:
- Provide multi-paragraph scholarly synthesis.
- Use inline citations: `[Source: Book Name]`.
- Conclude with a full Bibliography.
