import os
import google.generativeai as genai
import httpx
import json
import asyncio
from dotenv import load_dotenv

# Absolute path anchoring for portability
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
load_dotenv(os.path.join(BASE_DIR, '.env'))

# --- CONFIGURATION ---
GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")

# April 2026 Verified High-Performance Free Models
FALLBACK_MODELS = [
    "nvidia/nemotron-3-super-120b-a12b:free",  # Current #1 Healthy Free Model
    "openai/gpt-oss-120b:free",               # High-reasoning backup
    "z-ai/glm-4.5-air:free",                  # Fast agentic fallback
    "openrouter/free"                          # The "Magic" Auto-Router
]

async def ask_osho_stream(prompt, context):
    """
    Elite RAG Bridge: 
    1. Primary: Direct Google Gemini (1,500 req/day free).
    2. Secondary: Multi-model OpenRouter Failover.
    """
    
    system_prompt = (
        "You are Osho, the enlightened mystic. Your responses must be poetic, paradoxical, and profoundly transformative. "
        "Use the provided context from Osho's discourses to weave a scholarly yet soul-stirring response.\n\n"
        "STRICT SCHOLARLY REQUIREMENTS:\n"
        "1. Every major point must include an inline citation: [Source: Book Name/Discourse Title].\n"
        "2. Keep the synthesis concise: aim for 180-260 words, at most 3 short paragraphs.\n"
        "3. Conclude with a brief 'Bibliography' listing the Osho books found in the context.\n\n"
        f"Context:\n{context}"
    )

    # --- ATTEMPT 1: DIRECT GOOGLE BRIDGE ---
    if GOOGLE_API_KEY:
        try:
            # Clean the key in case of quote wrapping
            clean_key = GOOGLE_API_KEY.strip("'").strip('"')
            genai.configure(api_key=clean_key)
            model = genai.GenerativeModel('gemini-1.5-flash')
            
            response = model.generate_content(
                f"{system_prompt}\n\nUser Question: {prompt}",
                stream=True
            )
            for chunk in response:
                if chunk.text:
                    yield chunk.text
            return # Success
        except Exception as e:
            print(f"Direct Google Bridge saturated: {str(e)}")
            # Fall through to OpenRouter

    # --- ATTEMPT 2: OPENROUTER FAILOVER ARRAY ---
    if not OPENROUTER_API_KEY:
        yield "The stillness remains deep. Both the Direct Bridge and OpenRouter are unavailable."
        return

    headers = {
        "Authorization": f"Bearer {OPENROUTER_API_KEY}",
        "Content-Type": "application/json",
        "HTTP-Referer": "http://osho-wisdom-engine.com",
        "X-Title": "Osho Wisdom Engine"
    }

    async with httpx.AsyncClient(timeout=45.0) as client:
        for model in FALLBACK_MODELS:
            try:
                async with client.stream("POST", "https://openrouter.ai/api/v1/chat/completions", headers=headers, json={
                    "model": model,
                    "messages": [{"role": "system", "content": system_prompt}, {"role": "user", "content": prompt}],
                    "stream": True
                }) as response:
                    if response.status_code == 200:
                        async for line in response.aiter_lines():
                            if line.startswith("data: "):
                                data_str = line[6:].strip()
                                if data_str == "[DONE]": break
                                try:
                                    content = json.loads(data_str)['choices'][0]['delta'].get('content', '')
                                    if content: yield content
                                except: continue
                        return # Success
            except: continue

    yield "All engines are currently busy. Please wait 60 seconds for the free tier to reset."
