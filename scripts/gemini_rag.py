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
MODELS_TO_TRY = ["gemini-1.5-flash", "gemini-pro", "gemini-2.0-flash"]

def build_prompt(query, contexts):
    context_text = "\n\n".join([f"--- Context (from {c['event_title']}) ---\n{c['content']}" for c in contexts])
    
    prompt = f"""You are 'Osho Speaks..', a sophisticated interactive guide to the teachings of Osho. 
Your tone is poetic, profound, and scholarly, yet accessible.

Use the provided fragments from Osho's discourses to answer the user's question. 

CONSTRAINTS:
1. Stay strictly within the context of the provided fragments if possible.
2. If the fragments do not contain enough information, use your internal knowledge of Osho's style as a bridge.
3. Use 'The Void' aesthetic in your language—embrace silence and awareness.
4. Always cite the source discourse title.

SOURCE FRAGMENTS:
{context_text}

USER QUESTION:
{query}

WISDOM:"""
    return prompt

def ask_osho(query):
    if not GEMINI_API_KEY:
        return "The Engine is silent. Please configure the Gemini API Key to proceed."

    searcher = HybridSearcher()
    try:
        # 1. Retrieve context
        results = searcher.search(query, n_results=5)
        
        if not results:
            return "The silence remains deep. I found no fragments matching your inquiry in this current constellation."
            
        # 2. Construct prompt
        prompt = build_prompt(query, results)
        
        # 3. Call Gemini API with Fallback
        genai.configure(api_key=GEMINI_API_KEY)
        
        last_error = ""
        for model_name in MODELS_TO_TRY:
            try:
                model = genai.GenerativeModel(model_name)
                response = model.generate_content(prompt)
                return response.text
            except Exception as e:
                last_error = str(e)
                continue
        
        return f"A cloud has obscured the moon. All synthesis attempts failed. Last error: {last_error}"
        
    except Exception as e:
        return f"The search through the void failed: {str(e)}"
    finally:
        searcher.close()

if __name__ == "__main__":
    query = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "What is awareness?"
    print(ask_osho(query))
