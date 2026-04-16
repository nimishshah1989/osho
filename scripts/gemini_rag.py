import os
import sys
import google.generativeai as genai
from dotenv import load_dotenv

# Absolute path anchoring
BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_PATH = os.path.join(BASE_DIR, '.env')

# Ensure Base DIR is in path so we can import search
sys.path.append(BASE_DIR)
from scripts.search import HybridSearcher

# Load environment variables
load_dotenv(ENV_PATH)

# Configuration
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY")
# We will use an intelligent fallback loop to bypass temporary quota/404 issues
# Prioritizing 1.5-flash for the highest stability and rate-limit flexibility
MODELS_TO_TRY = ["gemini-1.5-flash", "gemini-1.5-pro", "gemini-2.0-flash"]
MAX_RETRIES = 3
INITIAL_RETRY_DELAY = 5 # seconds

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
    if not GEMINI_API_KEY:
        yield "The Engine is silent. Please configure the Gemini API Key to proceed."
        return

    try:
        # 1. Retrieve context (Search is now millisecond fast as searcher is pre-loaded)
        results = searcher.search(query, n_results=5)
        
        if not results:
            yield "The silence remains deep. I found no fragments matching your inquiry in this current constellation."
            return
            
        # 2. Construct prompt
        prompt = build_prompt(query, results)
        
        # 3. Call Gemini API with Streaming, Fallback, and Retries
        genai.configure(api_key=GEMINI_API_KEY)
        
        last_error = ""
        success = False
        
        for model_name in MODELS_TO_TRY:
            if success: break
            
            for attempt in range(MAX_RETRIES):
                try:
                    model = genai.GenerativeModel(model_name)
                    response = model.generate_content(prompt, stream=True)
                    
                    # Try to get the first chunk to verify it's working
                    chunk_it = iter(response)
                    try:
                        first_chunk = next(chunk_it)
                        if first_chunk.text:
                            yield first_chunk.text
                    except StopIteration:
                        pass

                    # Stream the rest
                    for chunk in chunk_it:
                        if chunk.text:
                            yield chunk.text
                    
                    success = True
                    break
                except Exception as e:
                    last_error = str(e)
                    # If it's a 429 (Rate limit), wait and retry
                    if "429" in last_error and attempt < MAX_RETRIES - 1:
                        wait_time = INITIAL_RETRY_DELAY * (2 ** attempt)
                        print(f"Wisdom Engine: Cloud detected ({model_name}). Waiting {wait_time}s to retry...")
                        import time
                        time.sleep(wait_time)
                        continue
                    else:
                        # Move to next model
                        break
        
        if not success:
            yield f"The cloud is thick. All synthesis attempts failed. Last error: {last_error}"
        
    except Exception as e:
        yield f"The search through the void failed: {str(e)}"

# Keep ask_osho for local testing/legacy
def ask_osho(query):
    import asyncio
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
