'use client';

import React, { useState } from 'react';
import { Search, Sparkles, Loader2 } from 'lucide-react';

export default function Home() {
  const [query, setQuery] = useState('');
  const [wisdom, setWisdom] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!query.trim() || isLoading) return;

    setIsLoading(true);
    setWisdom(""); 

    try {
      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });

      if (!response.ok) throw new Error("Connection interrupted.");

      const reader = response.body?.getReader();
      const decoder = new TextDecoder();

      if (!reader) throw new Error("Stream blocked.");

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = decoder.decode(value, { stream: true });
        setWisdom((prev) => (prev || "") + chunk);
      }
    } catch (error) {
      console.error(error);
      setWisdom("The stillness remains undisturbed. Please try again.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="min-h-screen bg-black text-ivory flex flex-col items-center justify-start pt-24 px-6 md:pt-40">
      <div className="w-full max-w-2xl">
        <h1 className="text-sm tracking-[1em] uppercase opacity-40 mb-12 text-center text-gold">
          Osho Wisdom Engine
        </h1>
        
        <form onSubmit={handleSearch} className="relative w-full mb-16">
          <input
            type="text"
            className="w-full bg-transparent border-b border-gold/30 py-4 text-xl md:text-2xl focus:border-gold outline-none transition-all placeholder:opacity-20 font-serif italic"
            placeholder="Ask anything..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button 
            type="submit"
            className="absolute right-0 top-1/2 -translate-y-1/2 text-gold transition-all"
            disabled={isLoading}
          >
            {isLoading ? <Loader2 className="animate-spin" size={24} /> : <Search size={24} />}
          </button>
        </form>

        {wisdom !== null && (
          <div className="w-full animate-in fade-in duration-700">
            <div className="flex items-center gap-4 mb-8 opacity-20">
              <div className="h-[1px] flex-1 bg-gold" />
              <Sparkles size={12} />
              <div className="h-[1px] flex-1 bg-gold" />
            </div>
            
            <div className="wisdom-output text-lg md:text-xl leading-relaxed font-serif italic whitespace-pre-wrap opacity-90 pb-20">
              {wisdom}
            </div>
            
            {wisdom && (
              <button 
                onClick={() => { setWisdom(null); setQuery(''); }}
                className="text-[10px] tracking-[0.5em] uppercase opacity-30 hover:opacity-100 transition-opacity text-gold mt-8"
              >
                New Inquiry
              </button>
            )}
          </div>
        )}
      </div>

      <footer className="fixed bottom-8 text-[9px] tracking-[0.4em] uppercase opacity-20">
        Oxford scholarly Edition | 2026
      </footer>
    </main>
  );
}

