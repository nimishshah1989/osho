import os
import sys
from openai import AsyncOpenAI
from dotenv import load_dotenv
import asyncio

# Absolute path anchoring
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(BASE_DIR, '.env')

# Ensure Base DIR is in path so we can import search
sys.path.append(BASE_DIR)
from scripts.search import HybridSearcher

# Load environment variables
load_dotenv(ENV_PATH)

# Configuration
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
MODEL = "google/gemini-2.0-flash-001:free"

def build_prompt(query, contexts):
    context_text = "\n\n".join([f"--- Context (from {c['event_title']}) ---\n{c['content']}\n[Source: {c['event_title']} | Read more: {c['source_url']}]" for c in contexts])
    
    prompt = f"""You are 'Osho Speaks..', a sophisticated interactive guide to the teachings of Osho. 
Your tone is poetic, profound, and scholarly, yet accessible.

Use the provided fragments from Osho's discourses to answer the user's question. 

CONSTRAINTS:
1. Stay strictly within the context of the provided fragments if possible.
2. If the fragments do not contain enough information, use your internal knowledge of Osho's style as a bridge.
3. Use 'The Void' aesthetic in your language—embrace silence and awareness.
4. Always cite the specific book or discourse title at the end of relevant points.
5. PROVIDE LINKS: Include at least one source link from the fragments (in markdown format [Source](URL)) at the very end of your response.

SOURCE FRAGMENTS:
{context_text}

USER QUESTION:
{query}

WISDOM:"""
    return prompt

async def ask_osho_stream(query, searcher):
    if not OPENROUTER_API_KEY:
        yield "The Engine is silent. Please configure the OpenRouter API Key to proceed."
        return

    try:
        # 1. Retrieve context
        results = searcher.search(query, n_results=5)
        
        if not results:
            yield "The silence remains deep. I found no fragments matching your inquiry in this current constellation."
            return
            
        # 2. Construct prompt
        prompt = build_prompt(query, results)
        
        # 3. Call OpenRouter API with Streaming
        client = AsyncOpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=OPENROUTER_API_KEY,
        )
        
        try:
            response = await client.chat.completions.create(
                model=MODEL,
                messages=[
                    {"role": "user", "content": prompt}
                ],
                stream=True,
            )
            
            async for chunk in response:
                if chunk.choices and chunk.choices[0].delta.content:
                    yield chunk.choices[0].delta.content
                    
        except Exception as e:
            yield f"The cloud is thick. All synthesis attempts failed. Last error: {str(e)}"
            
    except Exception as e:
        yield f"The search through the void failed: {str(e)}"

# Keep ask_osho for local testing/legacy
def ask_osho(query):
    searcher = HybridSearcher()
    try:
        wisdom = ""
        # Create a temporary loop to run the async generator
        async def _run():
            nonlocal wisdom
            async for chunk in ask_osho_stream(query, searcher):
                wisdom += chunk
        
        asyncio.run(_run())
        return wisdom
    finally:
        searcher.close()

if __name__ == "__main__":
    query = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "What is awareness?"
    print(ask_osho(query))
