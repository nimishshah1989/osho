'use client';

import React, { useState, useEffect, useMemo } from 'react';
import { ChevronRight, ChevronDown, BookOpen, Map as MapIcon, Globe, Calendar, Clock, Layers } from 'lucide-react';
import Link from 'next/link';

type SeriesMap = Record<string, string[]>;
type Hierarchy = Record<string, SeriesMap>;
type Lens = 'year' | 'era' | 'series';

const LENS_BUTTONS: { id: Lens; label: string; Icon: typeof Calendar }[] = [
  { id: 'year', label: 'By Year', Icon: Calendar },
  { id: 'era', label: 'By Era', Icon: Clock },
  { id: 'series', label: 'By Series', Icon: Layers },
];

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

function eraFor(year: string): string {
  if (!/^\d{4}$/.test(year)) return 'Undated';
  const y = parseInt(year, 10);
  if (y < 1970) return 'Bombay';
  if (y < 1981) return 'Poona I';
  if (y < 1986) return 'Rajneeshpuram';
  return 'Poona II';
}

const ERA_ORDER = ['Bombay', 'Poona I', 'Rajneeshpuram', 'Poona II', 'Undated'];

function sortYears(years: string[]): string[] {
  return [...years].sort((a, b) => {
    const numA = /^\d+$/.test(a) ? parseInt(a, 10) : -Infinity;
    const numB = /^\d+$/.test(b) ? parseInt(b, 10) : -Infinity;
    return numB - numA;
  });
}

interface BucketView {
  /** display label for the top-level group, e.g. "1973" or "Poona I" or "The Book of Secrets" */
  label: string;
  /** subtitle shown on the right ("12 Series", "1965-1969", "144 talks") */
  meta: string;
  /** children groups: series name → [talks]. For series-lens this is a single self-named group. */
  children: SeriesMap;
}

function regroup(hierarchy: Hierarchy, lens: Lens): BucketView[] {
  if (lens === 'year') {
    return sortYears(Object.keys(hierarchy)).map((year) => {
      const series = hierarchy[year];
      const seriesCount = Object.keys(series).length;
      return { label: year, meta: `${seriesCount} series`, children: series };
    });
  }
  if (lens === 'era') {
    const byEra = new Map<string, SeriesMap>();
    const yearsByEra = new Map<string, string[]>();
    for (const year of Object.keys(hierarchy)) {
      const era = eraFor(year);
      if (!byEra.has(era)) {
        byEra.set(era, {});
        yearsByEra.set(era, []);
      }
      yearsByEra.get(era)!.push(year);
      const target = byEra.get(era)!;
      for (const [series, talks] of Object.entries(hierarchy[year])) {
        if (!target[series]) target[series] = [];
        target[series].push(...talks);
      }
    }
    byEra.forEach((series) => {
      for (const t of Object.values(series)) t.sort();
    });
    return ERA_ORDER.filter((e) => byEra.has(e)).map((era) => {
      const years = (yearsByEra.get(era) ?? []).filter((y) => /^\d+$/.test(y)).map(Number).sort();
      const range = years.length ? `${years[0]}–${years[years.length - 1]}` : 'Undated';
      const seriesCount = Object.keys(byEra.get(era)!).length;
      return { label: era, meta: `${range} · ${seriesCount} series`, children: byEra.get(era)! };
    });
  }
  // series lens: flatten all years into series buckets
  const bySeries: Record<string, string[]> = {};
  for (const year of Object.keys(hierarchy)) {
    for (const [series, talks] of Object.entries(hierarchy[year])) {
      if (!bySeries[series]) bySeries[series] = [];
      bySeries[series].push(...talks);
    }
  }
  const seriesNames = Object.keys(bySeries).sort();
  return seriesNames.map((s) => {
    const talks = Array.from(new Set(bySeries[s])).sort();
    return { label: s, meta: `${talks.length} talk${talks.length === 1 ? '' : 's'}`, children: { [s]: talks } };
  });
}

export default function KnowledgeMap() {
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lens, setLens] = useState<Lens>('year');
  const [expandedTop, setExpandedTop] = useState<Set<string>>(new Set());
  const [expandedSub, setExpandedSub] = useState<Set<string>>(new Set());

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

  // Collapse all when lens changes — different keys would otherwise look "stuck open"
  useEffect(() => {
    setExpandedTop(new Set());
    setExpandedSub(new Set());
  }, [lens]);

  const buckets = useMemo<BucketView[]>(() => {
    if (!hierarchy) return [];
    return regroup(hierarchy, lens);
  }, [hierarchy, lens]);

  const toggleTop = (key: string) => {
    setExpandedTop((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleSub = (key: string) => {
    setExpandedSub((prev) => {
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

  const isEmpty = !hierarchy || buckets.length === 0;

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
        <div className="mb-10">
          <h1 className="text-4xl md:text-5xl font-serif italic mb-6 text-white tracking-wide">
            The Structural DNA
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed opacity-60">
            A chronological and series-based breakdown of the entire archive. Click any talk to ask
            Osho about it.
          </p>
        </div>

        {/* Lens switcher */}
        <div className="flex gap-2 mb-10 border-b border-gold/10 pb-3">
          {LENS_BUTTONS.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setLens(id)}
              aria-pressed={lens === id}
              className={`flex items-center gap-2 px-4 py-2 text-[10px] tracking-[0.3em] uppercase transition-all rounded-sm ${
                lens === id
                  ? 'text-gold bg-gold/5 border border-gold/30'
                  : 'text-ivory/50 hover:text-ivory border border-transparent'
              }`}
            >
              <Icon size={12} />
              {label}
            </button>
          ))}
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
          {buckets.map((bucket) => {
            const subKeys = Object.keys(bucket.children).sort();
            const isOnlyChild = subKeys.length === 1 && subKeys[0] === bucket.label;
            return (
              <div
                key={bucket.label}
                className="glass-panel border-l-2 border-gold/10 hover:border-gold/30 transition-colors"
              >
                <button
                  onClick={() => toggleTop(bucket.label)}
                  className="w-full text-left p-6 flex items-center justify-between group bg-transparent border-none cursor-pointer"
                >
                  <div className="flex items-center gap-6">
                    <span className="text-2xl font-serif italic text-gold/80">{bucket.label}</span>
                    <div className="h-[1px] w-12 bg-gold/10 group-hover:w-20 transition-all" />
                    <span className="text-[9px] tracking-[0.3em] uppercase opacity-40">
                      {bucket.meta}
                    </span>
                  </div>
                  {expandedTop.has(bucket.label) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>

                {expandedTop.has(bucket.label) && (
                  <div className="px-10 pb-8 space-y-6">
                    {subKeys.map((sub) => {
                      const subKey = bucket.label + '::' + sub;
                      const talks = bucket.children[sub];
                      const subOpen = isOnlyChild || expandedSub.has(subKey);
                      return (
                        <div key={sub} className="space-y-3">
                          {!isOnlyChild && (
                            <button
                              onClick={() => toggleSub(subKey)}
                              className="flex items-center gap-3 text-xs tracking-wider hover:text-gold transition-colors bg-transparent border-none cursor-pointer p-0"
                            >
                              {subOpen ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                              <span className="font-medium text-ivory/90 uppercase text-[10px] tracking-[0.2em]">
                                {sub}
                              </span>
                              <span className="text-[9px] opacity-30 ml-2">{talks.length}</span>
                            </button>
                          )}

                          {subOpen && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-1 pl-6 border-l border-gold/5">
                              {talks.map((talk, i) => (
                                <Link
                                  key={`${talk}-${i}`}
                                  href={`/ask?q=${encodeURIComponent(talk)}`}
                                  className="group flex items-center justify-between py-1 opacity-70 hover:opacity-100 transition-opacity no-underline"
                                >
                                  <span className="text-[11px] leading-relaxed cursor-pointer hover:text-gold transition-colors">
                                    {talk}
                                  </span>
                                  <BookOpen
                                    size={10}
                                    className="gold-accent opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-3"
                                  />
                                </Link>
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
