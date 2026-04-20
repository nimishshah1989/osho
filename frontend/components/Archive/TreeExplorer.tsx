'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import {
  BookOpen,
  Calendar,
  ChevronDown,
  ChevronRight,
  Clock,
  Globe2,
  Sparkles,
} from 'lucide-react';

interface Event {
  id: string;
  title: string;
  date: string | null;
  location: string | null;
}

interface CatalogResponse {
  events: Event[];
}

type Lens = 'time' | 'era' | 'geography' | 'theme';

const LENS_BUTTONS: { id: Lens; label: string; Icon: typeof Calendar }[] = [
  { id: 'time', label: 'By Year', Icon: Calendar },
  { id: 'era', label: 'By Era', Icon: Clock },
  { id: 'geography', label: 'By Place', Icon: Globe2 },
  { id: 'theme', label: 'By Theme', Icon: Sparkles },
];

const ERA_ORDER = ['Bombay', 'Poona I', 'Rajneeshpuram', 'Poona II', 'Undated'];

const THEMES: { name: string; keys: string[] }[] = [
  { name: 'Meditation', keys: ['meditation', 'dhyan', 'silence'] },
  { name: 'Zen', keys: ['zen', 'bodhidharma', 'hsin hsin ming'] },
  { name: 'Tantra', keys: ['tantra', 'vigyan bhairav'] },
  { name: 'Sufism', keys: ['sufi', 'rumi'] },
  { name: 'Love', keys: ['love', 'intimacy'] },
  { name: 'Philosophy', keys: ['philosoph', 'heraclitus', 'nietzsche'] },
];

function yearOf(date: string | null): string {
  const y = (date ?? '').slice(0, 4);
  return /^\d{4}$/.test(y) ? y : 'Undated';
}

function eraOf(date: string | null): string {
  const y = yearOf(date);
  if (!/^\d{4}$/.test(y)) return 'Undated';
  const n = parseInt(y, 10);
  if (n < 1970) return 'Bombay';
  if (n < 1981) return 'Poona I';
  if (n < 1986) return 'Rajneeshpuram';
  return 'Poona II';
}

function seriesOf(title: string): string {
  if (!title) return 'Uncategorised';
  if (title.includes(' ~ ')) return title.split(' ~ ', 1)[0].trim();
  return title.trim();
}

function themeOf(title: string): string {
  const t = (title ?? '').toLowerCase();
  for (const theme of THEMES) {
    if (theme.keys.some((k) => t.includes(k))) return theme.name;
  }
  return 'Other';
}

interface SeriesGroup {
  name: string;
  talks: Event[];
}

interface Bucket {
  label: string;
  meta: string;
  series: SeriesGroup[];
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>();
  for (const item of items) {
    const k = key(item);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(item);
  }
  return map;
}

function bucketsFromEvents(events: Event[], bucketKey: (e: Event) => string, order?: (a: string, b: string) => number): Bucket[] {
  const grouped = groupBy(events, bucketKey);
  const keys = Array.from(grouped.keys());
  keys.sort(order ?? ((a, b) => a.localeCompare(b)));

  return keys.map<Bucket>((k) => {
    const talks = grouped.get(k)!;
    const bySeries = groupBy(talks, (e) => seriesOf(e.title));
    const seriesNames = Array.from(bySeries.keys()).sort();
    const series = seriesNames.map<SeriesGroup>((s) => ({
      name: s,
      talks: bySeries.get(s)!.slice().sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.title.localeCompare(b.title)),
    }));
    return { label: k, meta: `${talks.length} talk${talks.length === 1 ? '' : 's'}`, series };
  });
}

function buildBuckets(events: Event[], lens: Lens): Bucket[] {
  if (lens === 'time') {
    return bucketsFromEvents(
      events,
      (e) => yearOf(e.date),
      (a, b) => {
        const na = /^\d+$/.test(a) ? parseInt(a, 10) : -Infinity;
        const nb = /^\d+$/.test(b) ? parseInt(b, 10) : -Infinity;
        return nb - na;
      },
    );
  }
  if (lens === 'era') {
    const buckets = bucketsFromEvents(events, (e) => eraOf(e.date));
    return buckets.sort((a, b) => ERA_ORDER.indexOf(a.label) - ERA_ORDER.indexOf(b.label));
  }
  if (lens === 'geography') {
    return bucketsFromEvents(
      events,
      (e) => (e.location && e.location.trim()) || 'Unknown',
      (a, b) => {
        // Keep Unknown at the bottom, size-descending is approximated by count in label.meta sort below
        if (a === 'Unknown') return 1;
        if (b === 'Unknown') return -1;
        return a.localeCompare(b);
      },
    );
  }
  return bucketsFromEvents(events, (e) => themeOf(e.title));
}

export default function TreeExplorer() {
  const [events, setEvents] = useState<Event[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lens, setLens] = useState<Lens>('time');
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [expandedSub, setExpandedSub] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    fetch('/api/catalog')
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error((body && body.error) || `Upstream status ${res.status}`);
        return body as CatalogResponse;
      })
      .then((body) => {
        if (!cancelled) setEvents(body.events ?? []);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message || 'Archive unreachable.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    setExpanded(new Set());
    setExpandedSub(new Set());
  }, [lens]);

  const buckets = useMemo(() => (events ? buildBuckets(events, lens) : []), [events, lens]);

  const toggleTop = (k: string) =>
    setExpanded((prev) => {
      const n = new Set(prev);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  const toggleSub = (k: string) =>
    setExpandedSub((prev) => {
      const n = new Set(prev);
      n.has(k) ? n.delete(k) : n.add(k);
      return n;
    });

  return (
    <main className="min-h-screen bg-black text-ivory font-sans selection:bg-gold/30">
      <div className="max-w-5xl mx-auto pt-32 pb-20 px-6 md:px-8">
        <div className="mb-10">
          <h1 className="text-4xl md:text-5xl font-serif italic mb-6 text-white tracking-wide">
            The Archive
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-ivory/85">
            Every indexed discourse, grouped by the lens of your choice. Click any talk to read it
            in full.
          </p>
        </div>

        <div className="flex flex-wrap gap-2 mb-10 border-b border-gold/10 pb-3">
          {LENS_BUTTONS.map(({ id, label, Icon }) => (
            <button
              key={id}
              onClick={() => setLens(id)}
              aria-pressed={lens === id}
              className={`flex items-center gap-2 px-4 py-2 text-[10px] tracking-[0.3em] uppercase transition-all rounded-sm ${
                lens === id
                  ? 'text-gold bg-gold/5 border border-gold/30'
                  : 'text-ivory/75 hover:text-ivory border border-transparent'
              }`}
            >
              <Icon size={12} />
              {label}
            </button>
          ))}
        </div>

        {loading && (
          <div className="animate-pulse text-[10px] tracking-[0.5em] uppercase text-gold/80">
            Unfolding the Archive...
          </div>
        )}

        {error && !loading && (
          <div className="border border-gold/20 rounded-sm p-6">
            <div className="text-[10px] tracking-[0.4em] uppercase text-gold mb-2">
              Archive unavailable
            </div>
            <div className="text-sm font-serif italic text-ivory/85">{error}</div>
          </div>
        )}

        {!loading && !error && buckets.length === 0 && (
          <div className="text-ivory/80 text-sm font-serif italic">
            The archive appears empty.
          </div>
        )}

        <div className="space-y-4">
          {buckets.map((bucket) => {
            const singleSeries = bucket.series.length === 1 && bucket.series[0].name === bucket.label;
            return (
              <div
                key={bucket.label}
                className="glass-panel border-l-2 border-gold/10 hover:border-gold/30 transition-colors"
              >
                <button
                  onClick={() => toggleTop(bucket.label)}
                  className="w-full text-left p-5 flex items-center justify-between group bg-transparent border-none cursor-pointer"
                >
                  <div className="flex items-center gap-6">
                    <span className="text-2xl font-serif italic text-gold">{bucket.label}</span>
                    <div className="h-[1px] w-12 bg-gold/10 group-hover:w-20 transition-all" />
                    <span className="text-[9px] tracking-[0.3em] uppercase text-ivory/70">
                      {bucket.meta}
                    </span>
                  </div>
                  {expanded.has(bucket.label) ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>

                {expanded.has(bucket.label) && (
                  <div className="px-8 pb-6 space-y-5">
                    {bucket.series.map((s) => {
                      const subKey = `${bucket.label}::${s.name}`;
                      const subOpen = singleSeries || expandedSub.has(subKey);
                      return (
                        <div key={s.name} className="space-y-2">
                          {!singleSeries && (
                            <button
                              onClick={() => toggleSub(subKey)}
                              className="flex items-center gap-3 text-xs hover:text-gold transition-colors bg-transparent border-none cursor-pointer p-0"
                            >
                              {subOpen ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                              <span className="font-medium text-ivory uppercase text-[10px] tracking-[0.2em]">
                                {s.name}
                              </span>
                              <span className="text-[9px] text-ivory/60">{s.talks.length}</span>
                            </button>
                          )}

                          {subOpen && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-1 pl-6 border-l border-gold/5">
                              {s.talks.map((t) => (
                                <Link
                                  key={t.id}
                                  href={`/read?event_id=${encodeURIComponent(t.id)}`}
                                  className="group flex items-center justify-between py-1 text-ivory/90 hover:text-ivory transition-colors no-underline"
                                >
                                  <span className="text-[11px] leading-relaxed group-hover:text-gold transition-colors">
                                    {t.title}
                                    {t.date && (
                                      <span className="text-ivory/60 ml-2 text-[10px]">{t.date.slice(0, 10)}</span>
                                    )}
                                  </span>
                                  <BookOpen
                                    size={10}
                                    className="text-gold opacity-0 group-hover:opacity-100 transition-opacity shrink-0 ml-3"
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
