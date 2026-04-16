'use client';

import React, { useState, useEffect } from 'react';
import { ChevronRight, ChevronDown, BookOpen, Clock, Map as MapIcon, Globe } from 'lucide-react';
import Link from 'next/link';

export default function KnowledgeMap() {
  const [hierarchy, setHierarchy] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [expandedYears, setExpandedYears] = useState<Set<string>>(new Set());
  const [expandedSeries, setExpandedSeries] = useState<Set<string>>(new Set());

  useEffect(() => {
    fetch('/api/hierarchy')
      .then(res => res.json())
      .then(data => {
        setHierarchy(data);
        setLoading(false);
      });
  }, []);

  const toggleYear = (year: string) => {
    const next = new Set(expandedYears);
    if (next.has(year)) next.delete(year);
    else next.add(year);
    setExpandedYears(next);
  };

  const toggleSeries = (series: string) => {
    const next = new Set(expandedSeries);
    if (next.has(series)) next.delete(series);
    else next.add(series);
    setExpandedSeries(next);
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-black flex items-center justify-center">
        <div className="flex flex-col items-center gap-4 animate-pulse">
          <div className="h-[1px] w-24 bg-gold mb-4 opacity-20" />
          <span className="text-[10px] tracking-[0.5em] uppercase gold-accent">Unfolding the Map</span>
        </div>
      </div>
    );
  }

  return (
    <main className="min-h-screen bg-black text-ivory/80 font-sans selection:bg-gold/30">
      {/* Premium Header */}
      <nav className="fixed top-0 w-full z-50 px-8 py-6 flex justify-between items-center backdrop-blur-md bg-black/50 border-b border-gold/5">
        <Link href="/" className="flex items-center gap-3 no-underline group">
          <div className="w-8 h-[1px] bg-gold group-hover:w-12 transition-all" />
          <span className="text-[11px] tracking-[0.6em] uppercase text-white font-medium">OSHO <span className="gold-accent italic">SPEAKS..</span></span>
        </Link>
        <div className="flex gap-12">
           <Link href="/" className="text-[9px] tracking-[0.4em] uppercase opacity-40 hover:opacity-100 transition-opacity flex items-center gap-2">
             <Globe size={12} className="gold-accent" /> THE NEBULA
           </Link>
           <span className="text-[9px] tracking-[0.4em] uppercase gold-accent flex items-center gap-2">
             <MapIcon size={12} /> THE MIND MAP
           </span>
        </div>
      </nav>

      <div className="max-w-5xl mx-auto pt-32 pb-20 px-8">
        <div className="mb-16">
          <h1 className="text-4xl md:text-5xl font-serif italic mb-6 text-white tracking-wide">The Structural DNA</h1>
          <p className="max-w-2xl text-sm leading-relaxed opacity-60">
            A chronological and series-based breakdown of the entire archive. From the early Poona years to the global silence, every discourse is mapped here as a structural point of light.
          </p>
        </div>

        <div className="space-y-4">
          {Object.keys(hierarchy).sort().reverse().map(year => (
            <div key={year} className="glass-panel border-l-2 border-gold/10 hover:border-gold/30 transition-colors">
              <button 
                onClick={() => toggleYear(year)}
                className="w-full text-left p-6 flex items-center justify-between group bg-transparent border-none cursor-pointer"
              >
                <div className="flex items-center gap-6">
                  <span className="text-2xl font-serif italic text-gold/80">{year}</span>
                  <div className="h-[1px] w-12 bg-gold/10 group-hover:w-20 transition-all" />
                  <span className="text-[9px] tracking-[0.3em] uppercase opacity-40">
                    {Object.keys(hierarchy[year]).length} Series
                  </span>
                </div>
                {expandedYears.has(year) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
              </button>

              {expandedYears.has(year) && (
                <div className="px-10 pb-8 space-y-6">
                  {Object.keys(hierarchy[year]).sort().map(series => (
                    <div key={series} className="space-y-3">
                      <button 
                        onClick={() => toggleSeries(year + series)}
                        className="flex items-center gap-3 text-xs tracking-wider hover:text-gold transition-colors bg-transparent border-none cursor-pointer p-0"
                      >
                        {expandedSeries.has(year + series) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                        <span className="font-medium text-ivory/90 uppercase text-[10px] tracking-[0.2em]">{series}</span>
                      </button>

                      {expandedSeries.has(year + series) && (
                        <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-2 pl-6 border-l border-gold/5">
                          {hierarchy[year][series].map((talk: string) => (
                            <div key={talk} className="group flex items-center justify-between py-1 opacity-60 hover:opacity-100 transition-opacity">
                              <span className="text-[11px] leading-relaxed cursor-pointer hover:text-gold transition-colors">
                                {talk}
                              </span>
                              <BookOpen size={10} className="gold-accent opacity-0 group-hover:opacity-100 transition-opacity" />
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          ))}
        </div>
      </div>
    </main>
  );
}
