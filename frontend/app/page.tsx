'use client';

import React, { useState } from 'react';
import { Search, Sparkles, Loader2, X } from 'lucide-react';
import dynamic from 'next/dynamic';

const ConstellationMap = dynamic(() => import('../components/Visuals/ConstellationMap'), { ssr: false });

export default function Home() {
  const [query, setQuery] = useState('');
  const [wisdom, setWisdom] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!query.trim() || isLoading) return;

    setIsLoading(true);
    setWisdom(null);

    try {
      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });

      const data = await response.json();
      if (data.wisdom) {
        setWisdom(data.wisdom);
      } else {
        setWisdom("The Void is silent. Perhaps try framing your inquiry differently.");
      }
    } catch (error) {
      setWisdom("A tremor in the connection. The stillness was interrupted.");
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="zen-container flex flex-col items-center justify-center min-h-screen relative overflow-hidden px-4">
      <div className="absolute inset-0 z-0">
        <ConstellationMap />
      </div>
      
      <div className={`w-full max-w-2xl z-20 flex flex-col items-center text-center transition-all duration-1000 ${wisdom ? 'opacity-0 scale-95 pointer-events-none' : 'opacity-100 scale-100'}`}>
        <div className="flex flex-col items-center mb-12">
          <div className="h-[1px] w-24 bg-gold mb-8 opacity-20" />
          <h1 className="wisdom-title text-4xl md:text-6xl tracking-[0.2em]">
            OSHO <span className="gold-accent italic">SPEAKS..</span>
          </h1>
          <div className="h-[1px] w-24 bg-gold mt-8 opacity-20" />
        </div>
        
        <form onSubmit={handleSearch} className="search-container relative w-full group max-w-xl">
          <input
            type="text"
            className="search-input w-full pl-8 pr-16"
            placeholder="Approach with Silence..."
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <button 
            type="submit"
            className="absolute right-4 top-1/2 -translate-y-1/2 text-gold opacity-50 hover:opacity-100 transition-all p-2 bg-transparent border-none cursor-pointer outline-none flex items-center justify-center"
            style={{ background: 'transparent', border: 'none' }}
          >
            {isLoading ? <Loader2 className="animate-spin" size={20} /> : <Search size={20} />}
          </button>
        </form>
        
        {isLoading && (
          <div className="searching-indicator flex items-center justify-center gap-3 mt-12 animate-pulse">
            <Sparkles size={14} className="gold-accent" />
            <span className="text-[10px] tracking-[0.3em] uppercase">Consulting the Stillness</span>
          </div>
        )}

        {!isLoading && !wisdom && (
          <p className="presence-statement mt-12">
            The void contains everything.
          </p>
        )}
      </div>

      {wisdom && (
        <div className="fixed inset-0 z-30 flex items-center justify-center p-4 md:p-10 bg-black/80 backdrop-blur-xl">
          <div className="wisdom-plate relative flex flex-col items-center text-center max-w-3xl w-full max-h-[90vh] overflow-y-auto custom-scrollbar p-8 md:p-16">
            <button 
              onClick={() => setWisdom(null)}
              className="absolute top-6 right-6 text-gray-500 hover:text-white transition-colors bg-transparent border-none cursor-pointer p-2 z-50"
              style={{ background: 'transparent', border: 'none' }}
            >
              <X size={24} />
            </button>
            
            <div className="flex items-center gap-3 mb-12 opacity-40">
              <div className="h-[1px] w-8 md:w-16 bg-gold" />
              <span className="text-[9px] md:text-[11px] tracking-[0.8em] md:tracking-[1.2em] uppercase gold-accent">The Synthesis</span>
              <div className="h-[1px] w-8 md:w-16 bg-gold" />
            </div>

            <div className="wisdom-content text-lg md:text-2xl leading-relaxed font-serif italic whitespace-pre-wrap text-ivory/90">
              {wisdom}
            </div>

            <div className="mt-16 text-center border-t border-gold/10 pt-8 w-full">
              <button 
                onClick={() => { setWisdom(null); setQuery(''); }}
                className="text-[10px] tracking-[0.5em] uppercase opacity-30 hover:opacity-100 transition-opacity gold-accent bg-transparent border-none cursor-pointer"
                style={{ background: 'transparent', border: 'none' }}
              >
                Enter the Silence Once More
              </button>
            </div>
          </div>
        </div>
      )}
      
      <footer className="footer-text z-10 w-full fixed bottom-8">
        © Osho Speaks.. | An Insight into the Timeless
      </footer>
    </main>
  );
}
