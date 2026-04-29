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
import {
  Search,
  Loader2,
  BookOpen,
  ArrowLeft,
  ChevronUp,
  ChevronDown,
} from 'lucide-react';
import Nav from '../components/Nav';
import HindiInput from '../components/HindiInput';
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
  language: string | null;
  rank: number;
  hit_count: number;
  hits: Hit[];
}

interface SearchResponse {
  query: string;
  total: number;
  total_hits: number;
  events: EventHit[];
}

interface Paragraph {
  sequence_number: number;
  content: string;
}

interface DiscourseResponse {
  event: {
    id: string;
    title: string | null;
    date: string | null;
    location: string | null;
    language: string | null;
  };
  paragraphs: Paragraph[];
}

type Sort = 'rank' | 'title';
type Mode = 'phrase' | 'all' | 'near';

const DEFAULT_PROX = 10;

const HAS_DEVANAGARI = /[\u0900-\u097F]/;

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
  for (const p of phrases) {
    if (!p) continue;
    if (HAS_DEVANAGARI.test(p)) {
      parts.push(escape(p));
    } else {
      parts.push(escape(p));
    }
  }
  for (const w of words) {
    if (w.endsWith('*')) {
      const stem = w.slice(0, -1);
      if (stem) parts.push(`\\b${escape(stem)}\\w*`);
    } else if (HAS_DEVANAGARI.test(w)) {
      // Devanagari: \b is ASCII-only and never matches Hindi characters.
      // Use the raw word — Devanagari syllables are space-delimited in text.
      parts.push(escape(w));
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
          <mark key={i} className="bg-yellow-300 dark:bg-yellow-500/40 text-[rgb(var(--fg))] font-bold rounded-sm px-0.5">
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
  const initialLang = searchParams?.get('lang') ?? '';
  const initialDateFrom = searchParams?.get('from') ?? '';
  const initialDateTo = searchParams?.get('to') ?? '';

  const [query, setQuery] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [proximity, setProximity] = useState<number>(initialProx);
  const [sort, setSort] = useState<Sort>(initialSort);
  const [langFilter, setLangFilter] = useState(initialLang);
  const [dateFrom, setDateFrom] = useState(initialDateFrom);
  const [dateTo, setDateTo] = useState(initialDateTo);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [selectedEventId, setSelectedEventId] = useState<string>(initialEvent);
  const [discourse, setDiscourse] = useState<DiscourseResponse | null>(null);
  const [discourseLoading, setDiscourseLoading] = useState(false);
  const [discourseError, setDiscourseError] = useState<string | null>(null);

  const looksRoman = locale === 'hi' && /[a-zA-Z]/.test(query);
  const devanagariPreview = useMemo(
    () => (looksRoman && query.trim() ? romanToDevanagari(query) : ''),
    [looksRoman, query],
  );

  const detailRef = useRef<HTMLDivElement | null>(null);
  const firstMatchRef = useRef<HTMLParagraphElement | null>(null);
  const discourseDetailsRef = useRef<HTMLDetailsElement | null>(null);

  const highlightPattern = useMemo(() => extractHighlights(submittedQuery), [submittedQuery]);

  const firstMatchIndex = useMemo(() => {
    if (!highlightPattern || !discourse) return -1;
    const re = new RegExp(highlightPattern.source, 'i');
    return discourse.paragraphs.findIndex((p) => re.test(p.content));
  }, [highlightPattern, discourse]);

  // All paragraph indices that contain a match (for next/prev navigation)
  const matchIndices = useMemo(() => {
    if (!highlightPattern || !discourse) return [];
    const re = new RegExp(highlightPattern.source, 'i');
    return discourse.paragraphs
      .map((p, idx) => (re.test(p.content) ? idx : -1))
      .filter((idx) => idx >= 0);
  }, [highlightPattern, discourse]);

  const [currentMatchPos, setCurrentMatchPos] = useState(0);
  const matchRefs = useRef<Map<number, HTMLParagraphElement>>(new Map());

  useEffect(() => {
    setCurrentMatchPos(0);
  }, [matchIndices]);

  const jumpToMatch = useCallback(
    (pos: number) => {
      if (!matchIndices.length) return;
      const clamped = Math.max(0, Math.min(pos, matchIndices.length - 1));
      setCurrentMatchPos(clamped);
      const paraIdx = matchIndices[clamped];
      const el = matchRefs.current.get(paraIdx);
      if (el) el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    },
    [matchIndices],
  );

  const syncUrl = useCallback(
    (q: string, s: Sort, event: string, m: Mode, prox: number) => {
      const params = new URLSearchParams();
      if (q) params.set('q', q);
      if (s !== 'rank') params.set('sort', s);
      if (event) params.set('event', event);
      if (m !== 'all') params.set('mode', m);
      if (m === 'near' && prox !== DEFAULT_PROX) params.set('prox', String(prox));
      if (langFilter) params.set('lang', langFilter);
      if (dateFrom) params.set('from', dateFrom);
      if (dateTo) params.set('to', dateTo);
      const qs = params.toString();
      router.replace(qs ? `/?${qs}` : '/', { scroll: false });
    },
    [router, langFilter, dateFrom, dateTo],
  );

  const runSearch = useCallback(
    async (rawQ: string, s: Sort, m: Mode, prox: number) => {
      const fts = buildQuery(rawQ, m, prox);
      if (!fts) return;
      setLoading(true);
      setError(null);
      try {
        const params = new URLSearchParams({ q: fts, sort: s });
        if (langFilter) params.set('language', langFilter);
        if (dateFrom) params.set('date_from', dateFrom);
        if (dateTo) params.set('date_to', dateTo);
        const r = await fetch(`/api/ask?${params.toString()}`);
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
    },
    [langFilter, dateFrom, dateTo],
  );

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
    return () => {
      cancelled = true;
    };
  }, [selectedEventId]);

  const doSearch = useCallback(
    (rawQ: string) => {
      const raw = rawQ.trim();
      if (!raw) return;

      // If there's still Roman text in Hindi mode, convert it for FTS
      const searchTerm =
        locale === 'hi' && /[a-zA-Z]/.test(raw)
          ? buildHindiFtsQuery(romanToDevanagari(raw))
          : /[\u0900-\u097F]/.test(raw)
            ? buildHindiFtsQuery(raw)
            : raw;

      setSelectedEventId('');
      syncUrl(searchTerm, sort, '', mode, proximity);
      void runSearch(searchTerm, sort, mode, proximity);
    },
    [locale, sort, mode, proximity, syncUrl, runSearch],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    doSearch(query);
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

  const handleLangFilterChange = (val: string) => {
    setLangFilter(val);
    if (query.trim() && results) {
      setTimeout(() => {
        void runSearch(query.trim(), sort, mode, proximity);
      }, 0);
    }
  };

  const selectEvent = (eventId: string) => {
    setSelectedEventId(eventId);
    syncUrl(query.trim(), sort, eventId, mode, proximity);
    setTimeout(() => {
      detailRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 50);
  };

  // Navigate to next/previous event in results list
  const navigateEvent = useCallback(
    (direction: 1 | -1) => {
      if (!results || !results.events.length) return;
      const currentIdx = results.events.findIndex((e) => e.event_id === selectedEventId);
      const nextIdx = currentIdx + direction;
      if (nextIdx >= 0 && nextIdx < results.events.length) {
        selectEvent(results.events[nextIdx].event_id);
      }
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [results, selectedEventId],
  );

  const clearSelection = () => {
    setSelectedEventId('');
    syncUrl(query.trim(), sort, '', mode, proximity);
  };

  const handleDetailsToggle = (e: React.SyntheticEvent<HTMLDetailsElement>) => {
    if (e.currentTarget.open && firstMatchRef.current) {
      setTimeout(() => {
        firstMatchRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      }, 60);
    }
  };

  // Keyboard shortcuts: j/k or arrow keys for hit navigation
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'n' || e.key === 'j') {
        e.preventDefault();
        jumpToMatch(currentMatchPos + 1);
      } else if (e.key === 'p' || e.key === 'k') {
        e.preventDefault();
        jumpToMatch(currentMatchPos - 1);
      } else if (e.key === 'ArrowDown' && e.altKey) {
        e.preventDefault();
        navigateEvent(1);
      } else if (e.key === 'ArrowUp' && e.altKey) {
        e.preventDefault();
        navigateEvent(-1);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [jumpToMatch, currentMatchPos, navigateEvent]);

  const selectedEvent = results?.events.find((e) => e.event_id === selectedEventId) ?? null;
  const selectedIdx = results?.events.findIndex((e) => e.event_id === selectedEventId) ?? -1;

  const placeholder =
    locale === 'hi'
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
            <h1 className="text-sm tracking-[0.35em] uppercase text-gold opacity-70 mb-4 font-medium">
              OSHO · {locale === 'hi' ? 'प्रवचन खोज' : 'Discourse Search'}
            </h1>

            <form onSubmit={handleSubmit} className="relative">
              {locale === 'hi' ? (
                <div className="relative">
                  <HindiInput
                    value={query}
                    onChange={setQuery}
                    onSubmit={() => doSearch(query)}
                    placeholder={placeholder}
                    className="w-full bg-transparent border-b-2 border-gold/40 py-4 pr-12 text-xl md:text-2xl focus:border-gold outline-none placeholder:opacity-40 text-[rgb(var(--fg))]"
                    disabled={loading}
                    autoFocus
                    ariaLabel={t('search.submit')}
                  />
                  <button
                    type="submit"
                    className="absolute right-0 top-1/2 -translate-y-1/2 text-gold disabled:opacity-30 z-10"
                    disabled={loading || !query.trim()}
                    aria-label={t('search.submit')}
                  >
                    {loading ? <Loader2 className="animate-spin" size={22} /> : <Search size={22} />}
                  </button>
                </div>
              ) : (
                <>
                  <input
                    type="text"
                    className="w-full bg-transparent border-b-2 border-gold/40 py-4 pr-12 text-xl md:text-2xl focus:border-gold outline-none placeholder:opacity-40 text-[rgb(var(--fg))]"
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
                </>
              )}
            </form>

            {/* Devanagari preview while typing Roman in Hindi mode */}
            {locale === 'hi' && devanagariPreview && (
              <div className="mt-2 flex items-center gap-2 text-sm text-gold">
                <span className="text-[10px] tracking-[0.2em] uppercase opacity-60">
                  {t('search.translit.preview')} →
                </span>
                <span className="font-medium">{devanagariPreview}</span>
              </div>
            )}
            {locale === 'hi' && !query && (
              <div className="mt-2 text-[11px] text-stone-400 dark:text-ivory/50">
                रोमन में टाइप करो (जैसे dhyaan, prem, shaanti)
              </div>
            )}

            <div className="mt-4 flex flex-wrap items-center gap-x-6 gap-y-3 text-[13px] tracking-[0.15em] uppercase">
              {/* Mode selector */}
              <div className="flex items-center gap-3">
                <span className="text-stone-500 dark:text-ivory/60">{t('search.match')}:</span>
                {(['phrase', 'all', 'near'] as Mode[]).map((m, idx) => (
                  <React.Fragment key={m}>
                    {idx > 0 && <span className="opacity-20">|</span>}
                    <button
                      type="button"
                      onClick={() => handleModeChange(m)}
                      className={
                        mode === m
                          ? 'text-gold font-bold underline underline-offset-4 decoration-2'
                          : 'text-stone-400 dark:text-ivory/50 hover:text-[rgb(var(--fg))]'
                      }
                      aria-pressed={mode === m}
                    >
                      {t(`search.mode.${m}`)}
                    </button>
                  </React.Fragment>
                ))}
              </div>

              {mode === 'near' && (
                <div className="flex items-center gap-2">
                  <span className="text-stone-500 dark:text-ivory/60">{t('search.prox.label')}</span>
                  <input
                    type="number"
                    min={0}
                    max={100}
                    value={proximity}
                    onChange={(e) => handleProximityChange(Number(e.target.value))}
                    className="w-14 bg-transparent border-b-2 border-gold/40 text-gold text-center py-1 focus:border-gold outline-none font-bold"
                    aria-label={t('search.mode.near')}
                  />
                  <span className="text-stone-400 dark:text-ivory/50">{t('search.prox.suffix')}</span>
                  {[5, 10, 20, 50].map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => handleProximityChange(v)}
                      className={
                        proximity === v
                          ? 'text-gold font-bold'
                          : 'text-stone-400 dark:text-ivory/50 hover:text-[rgb(var(--fg))]'
                      }
                    >
                      {v}
                    </button>
                  ))}
                </div>
              )}

              {/* Sort */}
              <div className="flex items-center gap-3">
                <span className="text-stone-500 dark:text-ivory/60">{t('search.sort')}:</span>
                <button
                  type="button"
                  onClick={() => handleSortChange('rank')}
                  className={
                    sort === 'rank'
                      ? 'text-gold font-bold underline underline-offset-4 decoration-2'
                      : 'text-stone-400 dark:text-ivory/50 hover:text-[rgb(var(--fg))]'
                  }
                >
                  {t('search.sort.rank')}
                </button>
                <span className="opacity-20">|</span>
                <button
                  type="button"
                  onClick={() => handleSortChange('title')}
                  className={
                    sort === 'title'
                      ? 'text-gold font-bold underline underline-offset-4 decoration-2'
                      : 'text-stone-400 dark:text-ivory/50 hover:text-[rgb(var(--fg))]'
                  }
                >
                  {t('search.sort.title')}
                </button>
              </div>

              {/* Language filter */}
              <div className="flex items-center gap-3">
                <span className="text-stone-500 dark:text-ivory/60">
                  {locale === 'hi' ? 'भाषा' : 'Lang'}:
                </span>
                {['', 'English', 'Hindi'].map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    onClick={() => handleLangFilterChange(lang)}
                    className={
                      langFilter === lang
                        ? 'text-gold font-bold underline underline-offset-4 decoration-2'
                        : 'text-stone-400 dark:text-ivory/50 hover:text-[rgb(var(--fg))]'
                    }
                  >
                    {lang === '' ? (locale === 'hi' ? 'सभी' : 'All') : lang}
                  </button>
                ))}
              </div>

              {/* Date range */}
              <div className="flex items-center gap-2">
                <span className="text-stone-500 dark:text-ivory/60">
                  {locale === 'hi' ? 'काल' : 'Period'}:
                </span>
                <input
                  type="text"
                  placeholder="1970"
                  maxLength={4}
                  value={dateFrom}
                  onChange={(e) => setDateFrom(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  className="w-16 bg-transparent border-b-2 border-gold/30 text-center py-0.5 focus:border-gold outline-none text-[rgb(var(--fg))]"
                />
                <span className="text-stone-400 dark:text-ivory/40">–</span>
                <input
                  type="text"
                  placeholder="1990"
                  maxLength={4}
                  value={dateTo}
                  onChange={(e) => setDateTo(e.target.value.replace(/\D/g, '').slice(0, 4))}
                  className="w-16 bg-transparent border-b-2 border-gold/30 text-center py-0.5 focus:border-gold outline-none text-[rgb(var(--fg))]"
                />
              </div>

              {results && (
                <span className="text-stone-600 dark:text-ivory/70 font-medium">
                  {results.total} {locale === 'hi' ? 'प्रवचन' : results.total === 1 ? 'discourse' : 'discourses'}
                  {' · '}
                  {results.total_hits} {locale === 'hi' ? 'अंश' : results.total_hits === 1 ? 'hit' : 'hits'}
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
              className="border border-gold/20 dark:border-gold/15 rounded-sm max-h-[calc(100vh-14rem)] overflow-y-auto"
            >
              {!results && !loading && !error && (
                <div className="p-6 text-base text-stone-500 dark:text-ivory/60">
                  {t('search.empty.pristine')}
                </div>
              )}
              {loading && !results && (
                <div className="p-6 text-base text-stone-500 dark:text-ivory/60 flex items-center gap-2">
                  <Loader2 className="animate-spin" size={16} /> {t('search.searching')}
                </div>
              )}
              {results && results.events.length === 0 && (
                <div className="p-6 text-base text-stone-500 dark:text-ivory/60">
                  {t('search.empty.none')}
                </div>
              )}
              {results && results.events.length > 0 && (
                <ul className="divide-y divide-gold/10">
                  <li className="sticky top-0 bg-[rgb(var(--bg-sticky))]/90 backdrop-blur px-4 py-2.5 text-[12px] tracking-[0.2em] uppercase text-stone-500 dark:text-ivory/55 font-medium flex justify-between">
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
                          className={`w-full text-left px-4 py-3.5 transition-colors flex justify-between items-start gap-4 ${
                            active
                              ? 'bg-gold/15 text-gold border-l-3 border-gold'
                              : 'hover:bg-stone-100 dark:hover:bg-ivory/5'
                          }`}
                        >
                          <span className="flex-1 min-w-0">
                            <span className="block text-[16px] leading-snug truncate font-medium">
                              {ev.title ?? 'Untitled'}
                            </span>
                            <span className="block text-[12px] tracking-[0.1em] text-stone-500 dark:text-ivory/55 mt-1">
                              {[ev.date, ev.location].filter(Boolean).join(' · ')}
                              {ev.hit_count > 0 && (
                                <> · <strong className="text-gold">{ev.hit_count}</strong> {locale === 'hi' ? 'अंश' : ev.hit_count === 1 ? 'hit' : 'hits'}</>
                              )}
                            </span>
                          </span>
                          <span className="text-[12px] tracking-[0.1em] text-stone-400 dark:text-ivory/40 flex-shrink-0 pt-1 font-medium">
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
              className="border border-gold/20 dark:border-gold/15 rounded-sm max-h-[calc(100vh-14rem)] overflow-y-auto"
            >
              {!selectedEvent && (
                <div className="p-6 text-base text-stone-500 dark:text-ivory/60">
                  {results && results.events.length > 0
                    ? t('search.detail.emptyWithResults')
                    : t('search.detail.emptyPristine')}
                </div>
              )}

              {selectedEvent && (
                <article className="p-6 md:p-8">
                  <div className="flex items-start justify-between gap-4 mb-6 pb-4 border-b border-gold/20">
                    <div>
                      <h2 className="text-lg md:text-xl text-gold leading-snug font-medium">
                        {selectedEvent.title ?? 'Untitled'}
                      </h2>
                      <div className="text-[13px] tracking-[0.15em] uppercase text-stone-500 dark:text-ivory/55 mt-1.5">
                        {[selectedEvent.date, selectedEvent.location, selectedEvent.language]
                          .filter(Boolean)
                          .join(' · ')}
                        {selectedEvent.hit_count > 0 && (
                          <> · <strong className="text-gold">{selectedEvent.hit_count} {locale === 'hi' ? 'अंश' : 'hits'}</strong></>
                        )}
                      </div>

                    </div>
                    <div className="flex items-center gap-3 flex-shrink-0">
                      {/* Prev/Next event navigation */}
                      {results && results.events.length > 1 && (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => navigateEvent(-1)}
                            disabled={selectedIdx <= 0}
                            className="p-1 text-gold/60 hover:text-gold disabled:opacity-20"
                            title={locale === 'hi' ? 'पिछला (Alt+↑)' : 'Previous event (Alt+↑)'}
                          >
                            <ChevronUp size={16} />
                          </button>
                          <span className="text-[12px] text-stone-400 dark:text-ivory/40 tabular-nums">
                            {selectedIdx + 1}/{results.events.length}
                          </span>
                          <button
                            type="button"
                            onClick={() => navigateEvent(1)}
                            disabled={selectedIdx >= results.events.length - 1}
                            className="p-1 text-gold/60 hover:text-gold disabled:opacity-20"
                            title={locale === 'hi' ? 'अगला (Alt+↓)' : 'Next event (Alt+↓)'}
                          >
                            <ChevronDown size={16} />
                          </button>
                        </div>
                      )}
                      <Link
                        href={`/read?event_id=${encodeURIComponent(selectedEvent.event_id)}`}
                        className="text-[13px] tracking-[0.15em] uppercase text-gold/80 hover:text-gold inline-flex items-center gap-1 font-medium"
                      >
                        <BookOpen size={14} /> {t('search.detail.full')}
                      </Link>
                      <button
                        type="button"
                        onClick={clearSelection}
                        className="text-[13px] tracking-[0.15em] uppercase text-stone-500 dark:text-ivory/55 hover:text-[rgb(var(--fg))] inline-flex items-center gap-1 md:hidden"
                      >
                        <ArrowLeft size={14} /> {t('search.detail.back')}
                      </button>
                    </div>
                  </div>

                  {/* Top matched passages */}
                  <div className="mb-6">
                    <h3 className="text-[12px] tracking-[0.2em] uppercase text-stone-500 dark:text-ivory/60 mb-3 font-medium">
                      {t('search.detail.topMatches')}
                    </h3>
                    <ol className="space-y-4">
                      {selectedEvent.hits.map((h) => (
                        <li
                          key={h.paragraph_id}
                          className="bg-stone-100 dark:bg-ivory/5 border-l-3 border-gold/50 pl-4 pr-3 py-3 text-stone-800 dark:text-ivory/95 leading-relaxed text-[16px]"
                        >
                          <div className="text-[12px] tracking-[0.15em] uppercase text-stone-400 dark:text-ivory/40 mb-1.5 font-medium">
                            Para {h.sequence_number}
                          </div>
                          <Highlighted text={h.content} pattern={highlightPattern} />
                        </li>
                      ))}
                    </ol>
                  </div>

                  {discourseLoading && (
                    <div className="text-sm text-stone-400 dark:text-ivory/60 flex items-center gap-2">
                      <Loader2 className="animate-spin" size={14} /> {t('search.detail.loadingFull')}
                    </div>
                  )}
                  {discourseError && (
                    <div className="text-sm text-stone-500 dark:text-ivory/60">{discourseError}</div>
                  )}

                  {discourse && discourse.event.id === selectedEvent.event_id && (
                    <details
                      ref={discourseDetailsRef}
                      className="mt-4 group"
                      onToggle={handleDetailsToggle}
                    >
                      <summary className="cursor-pointer text-[11px] tracking-[0.35em] uppercase text-gold/80 hover:text-gold select-none font-medium">
                        {t('search.detail.showAll', { n: discourse.paragraphs.length })}
                      </summary>

                      {/* Hit navigation controls */}
                      {matchIndices.length > 0 && (
                        <div className="mt-3 mb-2 flex items-center gap-3 text-[11px] tracking-[0.2em] uppercase">
                          <button
                            type="button"
                            onClick={() => jumpToMatch(currentMatchPos - 1)}
                            disabled={currentMatchPos <= 0}
                            className="px-2 py-1 border border-gold/30 rounded text-gold hover:bg-gold/10 disabled:opacity-30"
                          >
                            ← {locale === 'hi' ? 'पिछला' : 'Prev'} (p)
                          </button>
                          <span className="text-stone-500 dark:text-ivory/60 tabular-nums font-medium">
                            {currentMatchPos + 1} / {matchIndices.length} {locale === 'hi' ? 'अंश' : 'hits'}
                          </span>
                          <button
                            type="button"
                            onClick={() => jumpToMatch(currentMatchPos + 1)}
                            disabled={currentMatchPos >= matchIndices.length - 1}
                            className="px-2 py-1 border border-gold/30 rounded text-gold hover:bg-gold/10 disabled:opacity-30"
                          >
                            {locale === 'hi' ? 'अगला' : 'Next'} (n) →
                          </button>
                        </div>
                      )}

                      <div className="mt-4 space-y-3 text-stone-800 dark:text-ivory/90 leading-relaxed text-[17px]">
                        {discourse.paragraphs.map((p, idx) => {
                          const isMatch = matchIndices.includes(idx);
                          const isCurrent = matchIndices[currentMatchPos] === idx;
                          return (
                            <p
                              key={p.sequence_number}
                              ref={(el) => {
                                if (idx === firstMatchIndex && el) firstMatchRef.current = el;
                                if (isMatch && el) matchRefs.current.set(idx, el);
                              }}
                              className={
                                isCurrent
                                  ? 'scroll-mt-4 ring-2 ring-gold/40 bg-gold/5 rounded-sm px-3 -mx-3 py-1'
                                  : isMatch
                                    ? 'scroll-mt-4 ring-1 ring-gold/15 rounded-sm px-2 -mx-2'
                                    : undefined
                              }
                            >
                              <Highlighted text={p.content} pattern={highlightPattern} />
                            </p>
                          );
                        })}
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
