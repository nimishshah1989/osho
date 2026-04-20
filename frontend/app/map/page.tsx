'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { ChevronRight, ChevronDown, BookOpen, Map as MapIcon, Globe } from 'lucide-react';
import Link from 'next/link';

type SeriesMap = Record<string, string[]>;
type Hierarchy = Record<string, SeriesMap>;

function isHierarchy(value: unknown): value is Hierarchy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const [year, seriesMap] of Object.entries(value as Record<string, unknown>)) {
    if (typeof year !== 'string') return false;
    if (!seriesMap || typeof seriesMap !== 'object' || Array.isArray(seriesMap)) return false;
    for (const talks of Object.values(seriesMap as Record<string, unknown>)) {
      if (!Array.isArray(talks)) return false;
      if (!talks.every((t) => typeof t === 'string')) return false;
    }
  }
  return true;
}

function sortYears(years: string[]): string[] {
  return [...years].sort((a, b) => {
    const numA = /^\d+$/.test(a) ? parseInt(a, 10) : -Infinity;
    const numB = /^\d+$/.test(b) ? parseInt(b, 10) : -Infinity;
    return numB - numA;
  });
}

export default function KnowledgeMap() {
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expandedYears, setExpandedYears] = useState<Set<string>>(new Set());
  const [expandedSeries, setExpandedSeries] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    fetch('/api/hierarchy')
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) {
          throw new Error((body && body.error) || `Upstream status ${res.status}`);
        }
        return body;
      })
      .then((data: unknown) => {
        if (cancelled) return;
        if (!isHierarchy(data)) {
          setError('The archive returned an unexpected shape. Please retry shortly.');
          setHierarchy({});
        } else {
          setHierarchy(data);
        }
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setError(err.message || 'The mind-map is unreachable. Please retry shortly.');
        setHierarchy({});
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const sortedYears = useMemo(() => (hierarchy ? sortYears(Object.keys(hierarchy)) : []), [hierarchy]);

  const toggleYear = (year: string) => {
    setExpandedYears((prev) => {
      const next = new Set(prev);
      if (next.has(year)) next.delete(year);
      else next.add(year);
      return next;
    });
  };

  const toggleSeries = (key: string) => {
    setExpandedSeries((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
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

  const isEmpty = !hierarchy || sortedYears.length === 0;

  return (
    <main className="min-h-screen bg-black text-ivory/80 font-sans selection:bg-gold/30">
      <nav className="fixed top-0 w-full z-50 px-8 py-6 flex justify-between items-center backdrop-blur-md bg-black/50 border-b border-gold/5">
        <Link href="/" className="flex items-center gap-3 no-underline group">
          <div className="w-8 h-[1px] bg-gold group-hover:w-12 transition-all" />
          <span className="text-[11px] tracking-[0.6em] uppercase text-white font-medium">
            OSHO <span className="gold-accent italic">SPEAKS..</span>
          </span>
        </Link>
        <div className="flex gap-12">
          <Link
            href="/"
            className="text-[9px] tracking-[0.4em] uppercase opacity-40 hover:opacity-100 transition-opacity flex items-center gap-2"
          >
            <Globe size={12} className="gold-accent" /> THE NEBULA
          </Link>
          <span className="text-[9px] tracking-[0.4em] uppercase gold-accent flex items-center gap-2">
            <MapIcon size={12} /> THE MIND MAP
          </span>
        </div>
      </nav>

      <div className="max-w-5xl mx-auto pt-32 pb-20 px-8">
        <div className="mb-16">
          <h1 className="text-4xl md:text-5xl font-serif italic mb-6 text-white tracking-wide">
            The Structural DNA
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed opacity-60">
            A chronological and series-based breakdown of the entire archive. From the early Poona years to the
            global silence, every discourse is mapped here as a structural point of light.
          </p>
        </div>

        {error && (
          <div className="mb-10 border border-gold/20 bg-black/40 p-6 rounded-sm">
            <div className="text-[10px] tracking-[0.4em] uppercase gold-accent mb-2">Map Unavailable</div>
            <div className="text-sm opacity-70 font-serif italic mb-3">{error}</div>
            <button
              onClick={() => window.location.reload()}
              className="text-[10px] tracking-[0.4em] uppercase opacity-60 hover:opacity-100 transition-opacity"
            >
              Retry
            </button>
          </div>
        )}

        {!error && isEmpty && (
          <div className="opacity-60 text-sm font-serif italic">
            No discourses are indexed yet. Once the archive is synced, the map will bloom.
          </div>
        )}

        <div className="space-y-4">
          {sortedYears.map((year) => {
            const seriesMap = hierarchy![year];
            const seriesNames = Object.keys(seriesMap).sort();
            return (
              <div
                key={year}
                className="glass-panel border-l-2 border-gold/10 hover:border-gold/30 transition-colors"
              >
                <button
                  onClick={() => toggleYear(year)}
                  className="w-full text-left p-6 flex items-center justify-between group bg-transparent border-none cursor-pointer"
                >
                  <div className="flex items-center gap-6">
                    <span className="text-2xl font-serif italic text-gold/80">{year}</span>
                    <div className="h-[1px] w-12 bg-gold/10 group-hover:w-20 transition-all" />
                    <span className="text-[9px] tracking-[0.3em] uppercase opacity-40">
                      {seriesNames.length} Series
                    </span>
                  </div>
                  {expandedYears.has(year) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>

                {expandedYears.has(year) && (
                  <div className="px-10 pb-8 space-y-6">
                    {seriesNames.map((series) => {
                      const key = year + '::' + series;
                      const talks = seriesMap[series];
                      return (
                        <div key={series} className="space-y-3">
                          <button
                            onClick={() => toggleSeries(key)}
                            className="flex items-center gap-3 text-xs tracking-wider hover:text-gold transition-colors bg-transparent border-none cursor-pointer p-0"
                          >
                            {expandedSeries.has(key) ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                            <span className="font-medium text-ivory/90 uppercase text-[10px] tracking-[0.2em]">
                              {series}
                            </span>
                            <span className="text-[9px] opacity-30 ml-2">{talks.length}</span>
                          </button>

                          {expandedSeries.has(key) && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-2 pl-6 border-l border-gold/5">
                              {talks.map((talk, i) => (
                                <div
                                  key={`${talk}-${i}`}
                                  className="group flex items-center justify-between py-1 opacity-60 hover:opacity-100 transition-opacity"
                                >
                                  <span className="text-[11px] leading-relaxed cursor-pointer hover:text-gold transition-colors">
                                    {talk}
                                  </span>
                                  <BookOpen
                                    size={10}
                                    className="gold-accent opacity-0 group-hover:opacity-100 transition-opacity"
                                  />
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </main>
  );
}
