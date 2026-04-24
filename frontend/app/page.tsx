'use client';

import React, {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Search, Loader2, BookOpen, ArrowLeft, Languages } from 'lucide-react';
import Nav from '../components/Nav';
import { useLocale } from '../lib/i18n';
import { romanToDevanagari, buildHindiFtsQuery } from '../lib/transliterate';

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

function buildQuery(raw: string, mode: Mode, prox: number): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (mode === 'phrase') return `"${trimmed.replace(/"/g, '')}"`;
  if (mode === 'near') {
    const words = trimmed.split(/\s+/).filter(Boolean);
    if (words.length < 2) return trimmed;
    return `NEAR(${words.join(' ')}, ${Math.max(0, prox)})`;
  }
  return trimmed;
}

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
      {parts.map((part, i) =>
        i % 2 === 1 ? (
          <mark key={i} className="bg-gold/25 text-gold rounded-sm px-0.5">
            {part}
          </mark>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </>
  );
}

function SearchPageInner() {
  const { t, locale } = useLocale();
  const router = useRouter();
  const searchParams = useSearchParams();

  const initialQuery = searchParams?.get('q') ?? '';
  const initialSort: Sort = (searchParams?.get('sort') as Sort) === 'title' ? 'title' : 'rank';
  const initialEvent = searchParams?.get('event') ?? '';
  const initialModeParam = searchParams?.get('mode');
  const initialMode: Mode =
    initialModeParam === 'phrase' || initialModeParam === 'near' ? initialModeParam : 'all';
  const initialProxParam = Number(searchParams?.get('prox'));
  const initialProx =
    Number.isFinite(initialProxParam) && initialProxParam >= 0 && initialProxParam <= 100
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

  // Transliteration mode (only relevant when locale === 'hi')
  const [translitMode, setTranslitMode] = useState(false);
  const devanagariPreview = useMemo(
    () => (translitMode && query ? romanToDevanagari(query) : ''),
    [translitMode, query],
  );

  const detailRef = useRef<HTMLDivElement | null>(null);
  const firstMatchRef = useRef<HTMLParagraphElement | null>(null);
  const discourseDetailsRef = useRef<HTMLDetailsElement | null>(null);

  const highlightPattern = useMemo(() => extractHighlights(submittedQuery), [submittedQuery]);

  // Index of the first paragraph that contains a highlight match
  const firstMatchIndex = useMemo(() => {
    if (!highlightPattern || !discourse) return -1;
    const re = new RegExp(highlightPattern.source, 'i'); // non-global copy for safe .test()
    return discourse.paragraphs.findIndex((p) => re.test(p.content));
  }, [highlightPattern, discourse]);

  const syncUrl = useCallback(
    (q: string, s: Sort, event: string, m: Mode, prox: number) => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (s !== 'rank') params.set('sort', s);
      if (event) params.set('event', event);
      if (m !== 'all') params.set('mode', m);
      if (m === 'near' && prox !== DEFAULT_PROX) params.set('prox', String(prox));
      const qs = params.toString();
      router.replace(qs ? `/?${qs}` : '/', { scroll: false });
    },
    [router],
  );

  const runSearch = useCallback(async (rawQ: string, s: Sort, m: Mode, prox: number) => {
    const fts = buildQuery(rawQ, m, prox);
    if (!fts) return;
    setLoading(true);
    setError(null);
    try {
      const r = await fetch(`/api/ask?q=${encodeURIComponent(fts)}&sort=${s}`);
      const body = (await r.json().catch(() => null)) as SearchResponse | { error?: string } | null;
      if (!r.ok) {
        throw new Error((body && 'error' in body && body.error) || 'Archive unreachable.');
      }
      setSubmittedQuery(fts);
      setResults(body as SearchResponse);
    } catch (err) {
      setResults(null);
      setError(err instanceof Error ? err.message : 'Archive unreachable.');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (initialQuery) void runSearch(initialQuery, initialSort, initialMode, initialProx);
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
    return () => { cancelled = true; };
  }, [selectedEventId]);

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    const raw = query.trim();
    if (!raw) return;

    // In transliteration mode, convert Roman → Devanagari and expand anusvara variants
    const searchTerm = translitMode && locale === 'hi'
      ? buildHindiFtsQuery(romanToDevanagari(raw))
      : raw;

    setSelectedEventId('');
    syncUrl(searchTerm, sort, '', mode, proximity);
    void runSearch(searchTerm, sort, mode, proximity);
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
    setTimeout(() => {
      detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  const clearSelection = () => {
    setSelectedEventId('');
    syncUrl(query.trim(), sort, '', mode, proximity);
  };

  // Scroll to first matched paragraph when the details panel is opened
  const handleDetailsToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (e.currentTarget.open && firstMatchRef.current) {
      setTimeout(() => {
        firstMatchRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
    }
  };

  const selectedEvent = results?.events.find((e) => e.event_id === selectedEventId) ?? null;

  const placeholder = translitMode
    ? t('search.placeholder.roman')
    : mode === 'phrase'
      ? t('search.placeholder.phrase')
      : mode === 'near'
        ? t('search.placeholder.near')
        : t('search.placeholder.all');

  return (
    <>
      <Nav />
      <main className="min-h-screen bg-[rgb(var(--bg))] text-[rgb(var(--fg))] pt-20 md:pt-24 pb-16">
        <div className="max-w-7xl mx-auto px-4 md:px-8">

          <header className="mb-6">
            <h1 className="text-[10px] tracking-[0.6em] uppercase text-gold opacity-60 mb-4">
              OSHO · {t('search.title')}
            </h1>

            <form onSubmit={handleSubmit} className="relative">
              <input
                type="text"
                className="w-full bg-transparent border-b border-gold/30 py-3 pr-12 text-lg md:text-xl focus:border-gold outline-none placeholder:opacity-30 text-[rgb(var(--fg))]"
                placeholder={placeholder}
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                aria-label={t('search.submit')}
                autoFocus
              />
              <button
                type="submit"
                className="absolute right-0 top-1/2 -translate-y-1/2 text-gold disabled:opacity-30"
                disabled={loading || !query.trim()}
                aria-label={t('search.submit')}
              >
                {loading ? <Loader2 className="animate-spin" size={22} /> : <Search size={22} />}
              </button>
            </form>

            {/* Hindi transliteration preview */}
            {translitMode && locale === 'hi' && devanagariPreview && (
              <div className="mt-2 text-sm text-gold/80 flex items-center gap-2">
                <span className="text-[9px] tracking-[0.3em] uppercase opacity-60">
                  {t('search.translit.preview')}
                </span>
                <span>{devanagariPreview}</span>
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 text-[10px] tracking-[0.3em] uppercase text-stone-500 dark:text-ivory/60">

              {/* Mode selector */}
              <div className="flex items-center gap-3">
                <span>{t('search.match')}:</span>
                {(['phrase', 'all', 'near'] as Mode[]).map((m, idx) => (
                  <React.Fragment key={m}>
                    {idx > 0 && <span className="opacity-30">|</span>}
                    <button
                      type="button"
                      onClick={() => handleModeChange(m)}
                      className={mode === m ? 'text-gold' : 'hover:text-stone-900 dark:hover:text-ivory'}
                      aria-pressed={mode === m}
                    >
                      {t(`search.mode.${m}`)}
                    </button>
                  </React.Fragment>
                ))}
              </div>

              {mode === 'near' && (
                <div className="flex items-center gap-2">
                  <span>{t('search.prox.label')}</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={proximity}
                    onChange={(e) => handleProximityChange(Number(e.target.value))}
                    className="w-14 bg-transparent border-b border-gold/30 text-gold text-center py-1 focus:border-gold outline-none"
                    aria-label={t('search.mode.near')}
                  />
                  <span className="opacity-50">{t('search.prox.suffix')}</span>
                  {[5, 10, 20].map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => handleProximityChange(v)}
                      className={proximity === v ? 'text-gold' : 'hover:text-stone-900 dark:hover:text-ivory opacity-60'}
                    >
                      {v}
                    </button>
                  ))}
                </div>
              )}

              {/* Sort */}
              <div className="flex items-center gap-3">
                <span>{t('search.sort')}:</span>
                <button
                  type="button"
                  onClick={() => handleSortChange('rank')}
                  className={sort === 'rank' ? 'text-gold' : 'hover:text-stone-900 dark:hover:text-ivory'}
                >
                  {t('search.sort.rank')}
                </button>
                <span className="opacity-30">|</span>
                <button
                  type="button"
                  onClick={() => handleSortChange('title')}
                  className={sort === 'title' ? 'text-gold' : 'hover:text-stone-900 dark:hover:text-ivory'}
                >
                  {t('search.sort.title')}
                </button>
              </div>

              {/* Hindi transliteration toggle */}
              {locale === 'hi' && (
                <button
                  type="button"
                  onClick={() => setTranslitMode((v) => !v)}
                  className={`flex items-center gap-1.5 ${translitMode ? 'text-gold' : 'hover:text-stone-900 dark:hover:text-ivory'}`}
                  aria-pressed={translitMode}
                >
                  <Languages size={11} />
                  {t('search.translit.toggle')}
                </button>
              )}

              {results && (
                <span className="text-stone-600 dark:text-ivory/70">
                  {t(results.total === 1 ? 'search.results.one' : 'search.results.many', {
                    n: results.total,
                  })}
                </span>
              )}
            </div>
          </header>

          {error && (
            <div className="mb-6 text-sm text-stone-700 dark:text-ivory/85">{error}</div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-6 md:gap-10">

            {/* Left: results list */}
            <section
              aria-label="Results"
              className="border border-gold/15 dark:border-gold/10 rounded-sm max-h-[calc(100vh-14rem)] overflow-y-auto"
            >
              {!results && !loading && !error && (
                <div className="p-6 text-sm text-stone-500 dark:text-ivory/60">
                  {t('search.empty.pristine')}
                </div>
              )}
              {loading && !results && (
                <div className="p-6 text-sm text-stone-500 dark:text-ivory/60 flex items-center gap-2">
                  <Loader2 className="animate-spin" size={14} /> {t('search.searching')}
                </div>
              )}
              {results && results.events.length === 0 && (
                <div className="p-6 text-sm text-stone-500 dark:text-ivory/60">
                  {t('search.empty.none')}
                </div>
              )}
              {results && results.events.length > 0 && (
                <ul className="divide-y divide-gold/10">
                  <li className="sticky top-0 bg-[rgb(var(--bg-sticky))]/90 backdrop-blur px-4 py-2 text-[9px] tracking-[0.4em] uppercase text-stone-400 dark:text-ivory/50 flex justify-between">
                    <span>{t('search.col.discourse')}</span>
                    <span>{sort === 'rank' ? t('search.col.rankShort') : t('search.col.az')}</span>
                  </li>
                  {results.events.map((ev, i) => {
                    const active = ev.event_id === selectedEventId;
                    return (
                      <li key={ev.event_id}>
                        <button
                          type="button"
                          onClick={() => selectEvent(ev.event_id)}
                          className={`w-full text-left px-4 py-3 transition-colors flex justify-between items-start gap-4 ${
                            active
                              ? 'bg-gold/10 text-gold'
                              : 'hover:bg-stone-100 dark:hover:bg-ivory/5'
                          }`}
                        >
                          <span className="flex-1 min-w-0">
                            <span className="block text-sm leading-snug truncate">
                              {ev.title ?? 'Untitled'}
                            </span>
                            <span className="block text-[10px] tracking-[0.2em] uppercase text-stone-400 dark:text-ivory/50 mt-1">
                              {[ev.date, ev.location].filter(Boolean).join(' · ')}
                            </span>
                          </span>
                          <span className="text-[10px] tracking-[0.2em] uppercase text-stone-400 dark:text-ivory/40 flex-shrink-0 pt-1">
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
              className="border border-gold/15 dark:border-gold/10 rounded-sm max-h-[calc(100vh-14rem)] overflow-y-auto"
            >
              {!selectedEvent && (
                <div className="p-6 text-sm text-stone-500 dark:text-ivory/60">
                  {results && results.events.length > 0
                    ? t('search.detail.emptyWithResults')
                    : t('search.detail.emptyPristine')}
                </div>
              )}

              {selectedEvent && (
                <article className="p-6 md:p-8">
                  <div className="flex items-start justify-between gap-4 mb-6 pb-4 border-b border-gold/15">
                    <div>
                      <h2 className="text-base md:text-lg text-gold leading-snug">
                        {selectedEvent.title ?? 'Untitled'}
                      </h2>
                      <div className="text-[10px] tracking-[0.3em] uppercase text-stone-400 dark:text-ivory/50 mt-1">
                        {[selectedEvent.date, selectedEvent.location].filter(Boolean).join(' · ')}
                      </div>
                    </div>
                    <div className="flex items-center gap-4 flex-shrink-0">
                      <Link
                        href={`/read?event_id=${encodeURIComponent(selectedEvent.event_id)}`}
                        className="text-[10px] tracking-[0.3em] uppercase text-gold/80 hover:text-gold inline-flex items-center gap-1"
                      >
                        <BookOpen size={12} /> {t('search.detail.full')}
                      </Link>
                      <button
                        type="button"
                        onClick={clearSelection}
                        className="text-[10px] tracking-[0.3em] uppercase text-stone-400 dark:text-ivory/50 hover:text-stone-900 dark:hover:text-ivory inline-flex items-center gap-1 md:hidden"
                      >
                        <ArrowLeft size={12} /> {t('search.detail.back')}
                      </button>
                    </div>
                  </div>

                  {/* Top matched passages */}
                  <div className="mb-6">
                    <h3 className="text-[10px] tracking-[0.4em] uppercase text-stone-400 dark:text-ivory/60 mb-3">
                      {t('search.detail.topMatches')}
                    </h3>
                    <ol className="space-y-4">
                      {selectedEvent.hits.map((h) => (
                        <li
                          key={h.paragraph_id}
                          className="bg-stone-100 dark:bg-ivory/5 border-l-2 border-gold/40 pl-4 pr-3 py-3 text-stone-800 dark:text-ivory/95 leading-relaxed"
                        >
                          <div className="text-[9px] tracking-[0.3em] uppercase text-stone-400 dark:text-ivory/40 mb-1">
                            ¶ {h.sequence_number}
                          </div>
                          <Highlighted text={h.content} pattern={highlightPattern} />
                        </li>
                      ))}
                    </ol>
                  </div>

                  {discourseLoading && (
                    <div className="text-xs text-stone-400 dark:text-ivory/60 flex items-center gap-2">
                      <Loader2 className="animate-spin" size={12} /> {t('search.detail.loadingFull')}
                    </div>
                  )}
                  {discourseError && (
                    <div className="text-xs text-stone-500 dark:text-ivory/60">{discourseError}</div>
                  )}

                  {discourse && discourse.event.id === selectedEvent.event_id && (
                    <details
                      ref={discourseDetailsRef}
                      className="mt-4 group"
                      onToggle={handleDetailsToggle}
                    >
                      <summary className="cursor-pointer text-[10px] tracking-[0.4em] uppercase text-gold/80 hover:text-gold select-none">
                        {t('search.detail.showAll', { n: discourse.paragraphs.length })}
                      </summary>
                      <div className="mt-4 space-y-3 text-stone-800 dark:text-ivory/90 leading-relaxed text-[15px]">
                        {discourse.paragraphs.map((p, idx) => (
                          <p
                            key={p.sequence_number}
                            ref={idx === firstMatchIndex ? firstMatchRef : undefined}
                            className={
                              idx === firstMatchIndex
                                ? 'scroll-mt-4 ring-1 ring-gold/20 rounded-sm px-2 -mx-2'
                                : undefined
                            }
                          >
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

export default function SearchPage() {
  return (
    <Suspense fallback={null}>
      <SearchPageInner />
    </Suspense>
  );
}
