'use client';

import React, { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, Loader2, BookOpen, ArrowLeft } from 'lucide-react';
import Nav from '../../components/Nav';
import { useLocale } from '../../lib/i18n';

interface Hit {
  paragraph_id: number;
  sequence_number: number;
  content: string;
}

interface EventHit {
  event_id: string;
  title: string | null;
  date: string | null;
  location: string | null;
  rank: number;
  hits: Hit[];
}

interface SearchResponse {
  query: string;
  total: number;
  events: EventHit[];
}

interface Paragraph {
  sequence_number: number;
  content: string;
}

interface DiscourseResponse {
  event: { id: string; title: string | null; date: string | null; location: string | null };
  paragraphs: Paragraph[];
}

type Sort = 'rank' | 'title';
type Mode = 'phrase' | 'all' | 'near';

const DEFAULT_PROX = 10;

/**
 * Transform the user's plain input into an FTS5 query per the chosen mode.
 * `all` mode is passthrough — advanced users can still hand-type DSL
 * (quotes, NEAR, OR, prefix*, title:).
 */
function buildQuery(raw: string, mode: Mode, prox: number): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (mode === 'phrase') {
    return `"${trimmed.replace(/"/g, '')}"`;
  }
  if (mode === 'near') {
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length < 2) return trimmed;
    return `NEAR(${words.join(' ')}, ${Math.max(0, prox)})`;
  }
  return trimmed;
}

/**
 * Turn the FTS5 query into a list of highlight patterns.
 * Quoted phrases match literally; bare tokens match whole words
 * (or prefixes when trailing `*`).
 */
function extractHighlights(query: string): RegExp | null {
  if (!query) return null;
  const phrases: string[] = [];
  const stripped = query.replace(/"([^"]+)"/g, (_m, phrase: string) => {
    phrases.push(phrase.trim());
    return ' ';
  });
  const cleaned = stripped
    .replace(/\btitle\s*:\s*/gi, ' ')
    .replace(/\bNEAR\s*\(/gi, ' ')
    .replace(/\bOR\b/gi, ' ')
    .replace(/[(),]/g, ' ');
  const words = cleaned
    .split(/\s+/)
    .map((w) => w.trim())
    .filter((w) => w && !/^\d+$/.test(w));

  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts: string[] = [];
  for (const p of phrases) if (p) parts.push(escape(p));
  for (const w of words) {
    if (w.endsWith('*')) {
      const stem = w.slice(0, -1);
      if (stem) parts.push(`\\b${escape(stem)}\\w*`);
    } else {
      parts.push(`\\b${escape(w)}\\b`);
    }
  }
  if (!parts.length) return null;
  return new RegExp(`(${parts.join('|')})`, 'gi');
}

function Highlighted({ text, pattern }: { text: string; pattern: RegExp | null }) {
  if (!pattern) return <>{text}</>;
  const parts = text.split(pattern);
  return (
    <>
      {parts.map((part, i) => {
        if (i % 2 === 1) {
          return (
            <mark key={i} className="bg-gold/25 text-gold rounded-sm px-0.5">
              {part}
            </mark>
          );
        }
        return <React.Fragment key={i}>{part}</React.Fragment>;
      })}
    </>
  );
}

function AskPageInner() {
  const { t } = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();
  const initialQuery = searchParams?.get('q') ?? '';
  const initialSort = (searchParams?.get('sort') as Sort) === 'title' ? 'title' : 'rank';
  const initialEvent = searchParams?.get('event') ?? '';
  const initialModeParam = searchParams?.get('mode');
  const initialMode: Mode =
    initialModeParam === 'phrase' || initialModeParam === 'near' ? initialModeParam : 'all';
  const initialProxParam = Number(searchParams?.get('prox'));
  const initialProx = Number.isFinite(initialProxParam) && initialProxParam >= 0 && initialProxParam <= 100
    ? initialProxParam
    : DEFAULT_PROX;

  const [query, setQuery] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [proximity, setProximity] = useState<number>(initialProx);
  const [sort, setSort] = useState<Sort>(initialSort);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedEventId, setSelectedEventId] = useState<string>(initialEvent);
  const [discourse, setDiscourse] = useState<DiscourseResponse | null>(null);
  const [discourseLoading, setDiscourseLoading] = useState(false);
  const [discourseError, setDiscourseError] = useState<string | null>(null);

  const detailRef = useRef<HTMLDivElement | null>(null);
  const highlightPattern = useMemo(() => extractHighlights(submittedQuery), [submittedQuery]);

  const syncUrl = useCallback(
    (q: string, s: Sort, event: string, m: Mode, prox: number) => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (s !== 'rank') params.set('sort', s);
      if (event) params.set('event', event);
      if (m !== 'all') params.set('mode', m);
      if (m === 'near' && prox !== DEFAULT_PROX) params.set('prox', String(prox));
      const qs = params.toString();
      router.replace(qs ? `/ask?${qs}` : '/ask', { scroll: false });
    },
    [router],
  );

  const runSearch = useCallback(
    async (rawQ: string, s: Sort, m: Mode, prox: number) => {
      const fts = buildQuery(rawQ, m, prox);
      if (!fts) return;
      setLoading(true);
      setError(null);
      try {
        const r = await fetch(`/api/ask?q=${encodeURIComponent(fts)}&sort=${s}`);
        const body = (await r.json().catch(() => null)) as SearchResponse | { error?: string } | null;
        if (!r.ok) {
          const msg = (body && 'error' in body && body.error) || 'Archive unreachable.';
          throw new Error(msg);
        }
        setSubmittedQuery(fts);
        setResults(body as SearchResponse);
      } catch (err) {
        setResults(null);
        setError(err instanceof Error ? err.message : 'Archive unreachable.');
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  useEffect(() => {
    if (initialQuery) {
      void runSearch(initialQuery, initialSort, initialMode, initialProx);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!selectedEventId) {
      setDiscourse(null);
      setDiscourseError(null);
      return;
    }
    let cancelled = false;
    setDiscourseLoading(true);
    setDiscourseError(null);
    fetch(`/api/discourse?event_id=${encodeURIComponent(selectedEventId)}`)
      .then(async (r) => {
        const body = await r.json().catch(() => null);
        if (!r.ok) throw new Error((body && body.error) || `Status ${r.status}`);
        if (!cancelled) setDiscourse(body as DiscourseResponse);
      })
      .catch((err) => {
        if (!cancelled) {
          setDiscourse(null);
          setDiscourseError(err instanceof Error ? err.message : 'Discourse unavailable.');
        }
      })
      .finally(() => {
        if (!cancelled) setDiscourseLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedEventId]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const q = query.trim();
    if (!q) return;
    setSelectedEventId('');
    syncUrl(q, sort, '', mode, proximity);
    void runSearch(q, sort, mode, proximity);
  };

  const handleSortChange = (next: Sort) => {
    if (next === sort) return;
    setSort(next);
    if (query.trim()) {
      syncUrl(query.trim(), next, selectedEventId, mode, proximity);
      void runSearch(query.trim(), next, mode, proximity);
    }
  };

  const handleModeChange = (next: Mode) => {
    if (next === mode) return;
    setMode(next);
    if (query.trim() && results) {
      syncUrl(query.trim(), sort, '', next, proximity);
      setSelectedEventId('');
      void runSearch(query.trim(), sort, next, proximity);
    }
  };

  const handleProximityChange = (next: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(next || 0)));
    setProximity(clamped);
    if (mode === 'near' && query.trim() && results) {
      syncUrl(query.trim(), sort, '', mode, clamped);
      setSelectedEventId('');
      void runSearch(query.trim(), sort, mode, clamped);
    }
  };

  const selectEvent = (eventId: string) => {
    setSelectedEventId(eventId);
    syncUrl(query.trim(), sort, eventId, mode, proximity);
    // Scroll the right pane into view on mobile
    setTimeout(() => {
      detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  const clearSelection = () => {
    setSelectedEventId('');
    syncUrl(query.trim(), sort, '', mode, proximity);
  };

  const selectedEvent = results?.events.find((e) => e.event_id === selectedEventId) ?? null;

  return (
    <>
      <Nav />
      <main className="min-h-screen bg-black text-ivory pt-24 md:pt-28 pb-16">
        <div className="max-w-7xl mx-auto px-4 md:px-8">
          <header className="mb-6">
            <h1 className="text-sm tracking-[0.5em] uppercase text-gold opacity-70 mb-4">
              {t('ask.title')}
            </h1>
            <form onSubmit={handleSubmit} className="relative">
              <input
                type="text"
                className="w-full bg-transparent border-b border-gold/30 py-3 pr-12 text-lg md:text-xl focus:border-gold outline-none font-serif italic placeholder:opacity-30"
                placeholder={
                  mode === 'phrase'
                    ? t('ask.placeholder.phrase')
                    : mode === 'near'
                      ? t('ask.placeholder.near')
                      : t('ask.placeholder.all')
                }
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={t('ask.submit')}
                autoFocus
              />
              <button
                type="submit"
                className="absolute right-0 top-1/2 -translate-y-1/2 text-gold disabled:opacity-30"
                disabled={loading || !query.trim()}
                aria-label={t('ask.submit')}
              >
                {loading ? <Loader2 className="animate-spin" size={22} /> : <Search size={22} />}
              </button>
            </form>

            <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 text-[10px] tracking-[0.3em] uppercase text-ivory/60">
              <div className="flex items-center gap-3">
                <span>{t('ask.match')}:</span>
                <button
                  type="button"
                  onClick={() => handleModeChange('phrase')}
                  className={mode === 'phrase' ? 'text-gold' : 'hover:text-ivory'}
                  aria-pressed={mode === 'phrase'}
                >
                  {t('ask.mode.phrase')}
                </button>
                <span className="opacity-30">|</span>
                <button
                  type="button"
                  onClick={() => handleModeChange('all')}
                  className={mode === 'all' ? 'text-gold' : 'hover:text-ivory'}
                  aria-pressed={mode === 'all'}
                >
                  {t('ask.mode.all')}
                </button>
                <span className="opacity-30">|</span>
                <button
                  type="button"
                  onClick={() => handleModeChange('near')}
                  className={mode === 'near' ? 'text-gold' : 'hover:text-ivory'}
                  aria-pressed={mode === 'near'}
                >
                  {t('ask.mode.near')}
                </button>
              </div>

              {mode === 'near' && (
                <div className="flex items-center gap-2">
                  <span>{t('ask.prox.label')}</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={proximity}
                    onChange={(e) => handleProximityChange(Number(e.target.value))}
                    className="w-14 bg-transparent border-b border-gold/30 text-gold text-center py-1 focus:border-gold outline-none"
                    aria-label={t('ask.mode.near')}
                  />
                  <span className="opacity-50">{t('ask.prox.suffix')}</span>
                  {[5, 10, 20].map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => handleProximityChange(v)}
                      className={proximity === v ? 'text-gold' : 'hover:text-ivory opacity-60'}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              )}

              <div className="flex items-center gap-3">
                <span>{t('ask.sort')}:</span>
                <button
                  type="button"
                  onClick={() => handleSortChange('rank')}
                  className={sort === 'rank' ? 'text-gold' : 'hover:text-ivory'}
                >
                  {t('ask.sort.rank')}
                </button>
                <span className="opacity-30">|</span>
                <button
                  type="button"
                  onClick={() => handleSortChange('title')}
                  className={sort === 'title' ? 'text-gold' : 'hover:text-ivory'}
                >
                  {t('ask.sort.title')}
                </button>
              </div>
              {results && (
                <span className="text-ivory/70">
                  {t(results.total === 1 ? 'ask.results.one' : 'ask.results.many', {
                    n: results.total,
                  })}
                </span>
              )}
            </div>
          </header>

          {error && (
            <div className="mb-6 text-sm font-serif italic text-ivory/85">{error}</div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-6 md:gap-10">
            {/* Left: results list */}
            <section
              aria-label="Results"
              className="border border-gold/10 rounded-sm max-h-[calc(100vh-14rem)] overflow-y-auto"
            >
              {!results && !loading && !error && (
                <div className="p-6 text-sm text-ivory/60 font-serif italic">
                  {t('ask.empty.pristine')}
                </div>
              )}
              {loading && !results && (
                <div className="p-6 text-sm text-ivory/60 flex items-center gap-2">
                  <Loader2 className="animate-spin" size={14} /> {t('ask.searching')}
                </div>
              )}
              {results && results.events.length === 0 && (
                <div className="p-6 text-sm text-ivory/60 font-serif italic">
                  {t('ask.empty.none')}
                </div>
              )}
              {results && results.events.length > 0 && (
                <ul className="divide-y divide-gold/10">
                  <li className="sticky top-0 bg-black/90 backdrop-blur px-4 py-2 text-[9px] tracking-[0.4em] uppercase text-ivory/50 flex justify-between">
                    <span>{t('ask.col.discourse')}</span>
                    <span>{sort === 'rank' ? t('ask.col.rankShort') : t('ask.col.az')}</span>
                  </li>
                  {results.events.map((ev, i) => {
                    const active = ev.event_id === selectedEventId;
                    return (
                      <li key={ev.event_id}>
                        <button
                          type="button"
                          onClick={() => selectEvent(ev.event_id)}
                          className={`w-full text-left px-4 py-3 transition-colors flex justify-between items-start gap-4 ${
                            active ? 'bg-gold/10 text-gold' : 'hover:bg-ivory/5'
                          }`}
                        >
                          <span className="flex-1 min-w-0">
                            <span className="block text-sm leading-snug truncate">
                              {ev.title ?? 'Untitled'}
                            </span>
                            <span className="block text-[10px] tracking-[0.2em] uppercase text-ivory/50 mt-1">
                              {[ev.date, ev.location].filter(Boolean).join(' · ')}
                            </span>
                          </span>
                          <span className="text-[10px] tracking-[0.2em] uppercase text-ivory/40 flex-shrink-0 pt-1">
                            {sort === 'rank' ? `#${i + 1}` : ''}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </section>

            {/* Right: detail pane */}
            <section
              ref={detailRef}
              aria-label="Selected discourse"
              className="border border-gold/10 rounded-sm max-h-[calc(100vh-14rem)] overflow-y-auto"
            >
              {!selectedEvent && (
                <div className="p-6 text-sm text-ivory/60 font-serif italic">
                  {results && results.events.length > 0
                    ? t('ask.detail.emptyWithResults')
                    : t('ask.detail.emptyPristine')}
                </div>
              )}

              {selectedEvent && (
                <article className="p-6 md:p-8">
                  <div className="flex items-start justify-between gap-4 mb-6 pb-4 border-b border-gold/15">
                    <div>
                      <h2 className="text-base md:text-lg text-gold leading-snug">
                        {selectedEvent.title ?? 'Untitled'}
                      </h2>
                      <div className="text-[10px] tracking-[0.3em] uppercase text-ivory/50 mt-1">
                        {[selectedEvent.date, selectedEvent.location].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    <div className="flex items-center gap-4 flex-shrink-0">
                      <Link
                        href={`/read?event_id=${encodeURIComponent(selectedEvent.event_id)}`}
                        className="text-[10px] tracking-[0.3em] uppercase text-gold/80 hover:text-gold inline-flex items-center gap-1"
                      >
                        <BookOpen size={12} /> {t('ask.detail.full')}
                      </Link>
                      <button
                        type="button"
                        onClick={clearSelection}
                        className="text-[10px] tracking-[0.3em] uppercase text-ivory/50 hover:text-ivory inline-flex items-center gap-1 md:hidden"
                      >
                        <ArrowLeft size={12} /> {t('ask.detail.back')}
                      </button>
                    </div>
                  </div>

                  <div className="mb-6">
                    <h3 className="text-[10px] tracking-[0.4em] uppercase text-ivory/60 mb-3">
                      {t('ask.detail.topMatches')}
                    </h3>
                    <ol className="space-y-4">
                      {selectedEvent.hits.map((h) => (
                        <li
                          key={h.paragraph_id}
                          className="bg-ivory/5 border-l-2 border-gold/40 pl-4 pr-3 py-3 font-serif text-ivory/95 leading-relaxed"
                        >
                          <div className="text-[9px] tracking-[0.3em] uppercase text-ivory/40 mb-1">
                            ¶ {h.sequence_number}
                          </div>
                          <Highlighted text={h.content} pattern={highlightPattern} />
                        </li>
                      ))}
                    </ol>
                  </div>

                  {discourseLoading && (
                    <div className="text-xs text-ivory/60 flex items-center gap-2">
                      <Loader2 className="animate-spin" size={12} /> {t('ask.detail.loadingFull')}
                    </div>
                  )}
                  {discourseError && (
                    <div className="text-xs text-ivory/60 font-serif italic">{discourseError}</div>
                  )}
                  {discourse && discourse.event.id === selectedEvent.event_id && (
                    <details className="mt-4 group">
                      <summary className="cursor-pointer text-[10px] tracking-[0.4em] uppercase text-gold/80 hover:text-gold select-none">
                        {t('ask.detail.showAll', { n: discourse.paragraphs.length })}
                      </summary>
                      <div className="mt-4 space-y-3 font-serif text-ivory/90 leading-relaxed">
                        {discourse.paragraphs.map((p) => (
                          <p key={p.sequence_number} className="text-[15px]">
                            <Highlighted text={p.content} pattern={highlightPattern} />
                          </p>
                        ))}
                      </div>
                    </details>
                  )}
                </article>
              )}
            </section>
          </div>
        </div>
      </main>
    </>
  );
}

export default function AskPage() {
  return (
    <Suspense fallback={null}>
      <AskPageInner />
    </Suspense>
  );
}
