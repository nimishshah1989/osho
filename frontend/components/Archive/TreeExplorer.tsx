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
import { useLocale } from '../../lib/i18n';

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

const LENS_BUTTONS: { id: Lens; i18nKey: string; Icon: typeof Calendar }[] = [
  { id: 'time',      i18nKey: 'archive.lens.time',      Icon: Calendar },
  { id: 'era',       i18nKey: 'archive.lens.era',        Icon: Clock },
  { id: 'geography', i18nKey: 'archive.lens.geography',  Icon: Globe2 },
  { id: 'theme',     i18nKey: 'archive.lens.theme',      Icon: Sparkles },
];

// Historical eras in the correct chronological order
const ERA_ORDER = ['Bombay', 'Poona I', 'Rajneeshpuram', 'World Tour', 'Poona II', 'Undated'];

const THEMES: { name: string; keys: string[] }[] = [
  { name: 'Meditation', keys: ['meditation', 'dhyan', 'silence'] },
  { name: 'Zen',        keys: ['zen', 'bodhidharma', 'hsin hsin ming'] },
  { name: 'Tantra',     keys: ['tantra', 'vigyan bhairav'] },
  { name: 'Sufism',     keys: ['sufi', 'rumi'] },
  { name: 'Love',       keys: ['love', 'intimacy'] },
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
  if (n <= 1984) return 'Rajneeshpuram';
  if (n <= 1986) return 'World Tour';  // 1985-1986: world travel period
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
  count: number;
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

function bucketsFromEvents(
  events: Event[],
  bucketKey: (e: Event) => string,
  order?: (a: string, b: string) => number,
): Bucket[] {
  const grouped = groupBy(events, bucketKey);
  const keys = Array.from(grouped.keys());
  keys.sort(order ?? ((a, b) => a.localeCompare(b)));

  return keys.map<Bucket>((k) => {
    const talks = grouped.get(k)!;
    const bySeries = groupBy(talks, (e) => seriesOf(e.title));
    const seriesNames = Array.from(bySeries.keys()).sort();
    const series = seriesNames.map<SeriesGroup>((s) => ({
      name: s,
      talks: bySeries
        .get(s)!
        .slice()
        .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '') || a.title.localeCompare(b.title)),
    }));
    return { label: k, count: talks.length, series };
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
        if (a === 'Unknown') return 1;
        if (b === 'Unknown') return -1;
        return a.localeCompare(b);
      },
    );
  }
  return bucketsFromEvents(events, (e) => themeOf(e.title));
}

export default function TreeExplorer() {
  const { t } = useLocale();
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
      .then((body) => { if (!cancelled) setEvents(body.events ?? []); })
      .catch((err: Error) => { if (!cancelled) setError(err.message || 'Archive unreachable.'); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
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
    <main className="min-h-screen bg-[rgb(var(--bg))] text-[rgb(var(--fg))] selection:bg-gold/30">
      <div className="max-w-5xl mx-auto pt-28 pb-20 px-6 md:px-8">

        <div className="mb-10">
          <h1 className="text-3xl md:text-4xl font-sans font-light mb-4 tracking-wide text-[rgb(var(--fg))]">
            {t('archive.title')}
          </h1>
          <p className="max-w-2xl text-sm leading-relaxed text-stone-600 dark:text-ivory/85">
            {t('archive.lead')}
          </p>
        </div>

        <div className="flex flex-wrap gap-2 mb-10 border-b border-gold/15 dark:border-gold/10 pb-3">
          {LENS_BUTTONS.map(({ id, i18nKey, Icon }) => (
            <button
              key={id}
              onClick={() => setLens(id)}
              aria-pressed={lens === id}
              className={`flex items-center gap-2 px-4 py-2 text-[10px] tracking-[0.3em] uppercase transition-all rounded-sm ${
                lens === id
                  ? 'text-gold bg-gold/5 border border-gold/30'
                  : 'text-stone-500 dark:text-ivory/75 hover:text-stone-900 dark:hover:text-ivory border border-transparent'
              }`}
            >
              <Icon size={12} />
              {t(i18nKey)}
            </button>
          ))}
        </div>

        {loading && (
          <div className="animate-pulse text-[10px] tracking-[0.5em] uppercase text-gold/80">
            {t('archive.loading')}
          </div>
        )}

        {error && !loading && (
          <div className="border border-gold/20 rounded-sm p-6">
            <div className="text-[10px] tracking-[0.4em] uppercase text-gold mb-2">
              {t('archive.error')}
            </div>
            <div className="text-sm text-stone-600 dark:text-ivory/85">{error}</div>
          </div>
        )}

        {!loading && !error && buckets.length === 0 && (
          <div className="text-stone-500 dark:text-ivory/80 text-sm">
            {t('archive.empty')}
          </div>
        )}

        <div className="space-y-4">
          {buckets.map((bucket) => {
            const singleSeries =
              bucket.series.length === 1 && bucket.series[0].name === bucket.label;
            return (
              <div
                key={bucket.label}
                className="border-l-2 border-gold/15 hover:border-gold/35 dark:border-gold/10 dark:hover:border-gold/30 transition-colors bg-stone-50/50 dark:bg-white/[0.02]"
              >
                <button
                  onClick={() => toggleTop(bucket.label)}
                  className="w-full text-left p-5 flex items-center justify-between group bg-transparent border-none cursor-pointer"
                >
                  <div className="flex items-center gap-6">
                    <span className="text-2xl font-light text-gold">{bucket.label}</span>
                    <div className="h-[1px] w-12 bg-gold/10 group-hover:w-20 transition-all" />
                    <span className="text-[9px] tracking-[0.3em] uppercase text-stone-400 dark:text-ivory/70">
                      {t(bucket.count === 1 ? 'archive.talks.one' : 'archive.talks.many', {
                        n: bucket.count,
                      })}
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
                              <span className="font-medium text-stone-700 dark:text-ivory uppercase text-[10px] tracking-[0.2em]">
                                {s.name}
                              </span>
                              <span className="text-[9px] text-stone-400 dark:text-ivory/60">{s.talks.length}</span>
                            </button>
                          )}

                          {subOpen && (
                            <div className="grid grid-cols-1 md:grid-cols-2 gap-x-10 gap-y-1 pl-6 border-l border-gold/5">
                              {s.talks.map((talk) => (
                                <Link
                                  key={talk.id}
                                  href={`/read?event_id=${encodeURIComponent(talk.id)}`}
                                  className="group flex items-center justify-between py-1 text-stone-700 dark:text-ivory/90 hover:text-stone-900 dark:hover:text-ivory transition-colors no-underline"
                                >
                                  <span className="text-[11px] leading-relaxed group-hover:text-gold transition-colors">
                                    {talk.title}
                                    {talk.date && (
                                      <span className="text-stone-400 dark:text-ivory/60 ml-2 text-[10px]">
                                        {talk.date.slice(0, 10)}
                                      </span>
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
