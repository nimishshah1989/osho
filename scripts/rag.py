import sys
import os
import requests
from search import HybridSearcher

# Configuration
OLLAMA_API_BASE = "http://localhost:11434/api/chat"
MODEL_NAME = "qwen2.5-coder:latest"

def build_prompt(query, contexts):
    context_text = "\n\n".join([f"--- Context (from {c['event_title']}) ---\n{c['content']}" for c in contexts])
    
    prompt = f"""You are the Osho Wisdom Engine, a sophisticated interactive guide to the teachings of Osho. 
Your tone is poetic, profound, and scholarly, yet accessible—mirroring the 'Oxford-grade' aesthetic of our platform.

Use the provided fragments from Osho's discourses to answer the user's question. 

CONSTRAINTS:
1. Stay strictly within the context of the provided fragments if possible.
2. If the fragments do not contain enough information, use your internal knowledge of Osho's style to bridge the gap, but explicitly mention if you are synthesizing beyond the provided context.
3. Use 'The Void' aesthetic in your language—embrace silence, awareness, and the 'no-mind' state.
4. If appropriate, cite the source discourse title mentioned in the context.

SOURCE FRAGMENTS:
{context_text}

USER QUESTION:
{query}

WISDOM:"""
    return prompt

def ask_osho(query):
    searcher = HybridSearcher()
    try:
        # Retrieve context
        results = searcher.search(query, n_results=5)
        
        if not results:
            return "The silence remains deep. I found no fragments matching your inquiry in this current constellation."
            
        # Construct prompt
        prompt = build_prompt(query, results)
        
        print(f"\nConstructing wisdom synthesis with {MODEL_NAME}...\n")
        
        # Call Local LLM via Ollama API directly
        payload = {
            "model": MODEL_NAME,
            "messages": [
                {"role": "system", "content": "You are the Osho Wisdom Engine. Synthesize the provided discourse fragments into a profound response."},
                {"role": "user", "content": prompt}
            ],
            "stream": False
        }
        
        response = requests.post(OLLAMA_API_BASE, json=payload)
        response.raise_for_status()
        
        return response.json()['message']['content']
        
    except Exception as e:
        return f"A cloud has obscured the moon. Error: {str(e)}"
    finally:
        searcher.close()

if __name__ == "__main__":
    query = " ".join(sys.argv[1:]) if len(sys.argv) > 1 else "What does Osho say about the nature of silence?"
    
    wisdom = ask_osho(query)
    print("\n" + "="*50)
    print("THE WISDOM ENGINE")
    print("="*50)
    print(wisdom)
    print("="*50)
