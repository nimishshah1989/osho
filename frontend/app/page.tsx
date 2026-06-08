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
import { formatReadableDate } from '../lib/dateFormat';
import { romanToDevanagari, buildHindiFtsQuery } from '../lib/transliterate';
import { paragraphRoleClass, cx } from '../lib/paragraphRole';
import { useOfflineEngine } from '../lib/search/OfflineProvider';
import { discourseApi, languagesApi, searchApi } from '../lib/search/searchApi';
import type { SearchHit, SearchEvent, SearchResponse } from '../lib/search';
import {
  trackSearch, trackSearchEmpty, trackResultClick, trackDiscourseOpen,
  trackModeChange, trackProxChange, trackLanguageFilter, trackSortChange,
  trackPageView,
} from '../lib/analytics';

// Search-result types come from the engine layer — same shape whether
// the search ran locally via sqlite-wasm or via the FastAPI proxy.
type Hit = SearchHit;
type EventHit = SearchEvent;

interface Paragraph {
  sequence_number: number;
  content: string;
  hl?: string;
  role?: string;
}

interface DiscourseResponse {
  event: {
    id: string;
    title: string | null;
    date: string | null;
    location: string | null;
    language: string | null;
    translated_from?: string | null;
    source_short?: string | null;
  };
  paragraphs: Paragraph[];
}

type Sort = 'rank' | 'title';
type Mode = 'phrase' | 'all' | 'near';

const DEFAULT_PROX = 30;

const HAS_DEVANAGARI = /[\u0900-\u097F]/;

/** Translation-provenance line for the search result + reader header.
 *  Returns null when the record is original-language ("none" or empty). */
function translationLine(
  translatedFrom: string | null | undefined,
  sourceShort: string | null | undefined,
  locale: 'en' | 'hi',
): string | null {
  const tf = (translatedFrom ?? '').trim();
  if (!tf || tf.toLowerCase() === 'none') return null;
  const book = (sourceShort ?? '').trim();
  if (locale === 'hi') {
    return book
      ? `${tf} \u0938\u0947 \u0905\u0928\u0942\u0926\u093F\u0924 \u00B7 ${book}`
      : `${tf} \u0938\u0947 \u0905\u0928\u0942\u0926\u093F\u0924`;
  }
  return book
    ? `translated from ${tf} \u00B7 ${book}`
    : `translated from ${tf}`;
}

function buildQuery(raw: string, mode: Mode, prox: number): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  if (mode === 'phrase') {
    // If the value has already been OR-expanded by expandQuery (single Hindi
    // word → `(रूद्र OR रुद्र)`), don't wrap it in quotes — you can't OR
    // inside a phrase. Multi-word phrases like "love is god" still get
    // the phrase wrap so word order is preserved.
    if (trimmed.startsWith('(') && trimmed.includes(' OR ')) return trimmed;
    return `"${trimmed.replace(/"/g, '')}"`;
  }
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
    parts.push(escape(p));
  }
  for (const w of words) {
    if (w.endsWith('*')) {
      const stem = w.slice(0, -1);
      if (stem) {
        if (HAS_DEVANAGARI.test(stem)) {
          parts.push(`${escape(stem)}\\S*`);
        } else {
          parts.push(`\\b${escape(stem)}\\w*`);
        }
      }
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

function Highlighted({ text, hl, pattern }: { text: string; hl?: string; pattern: RegExp | null }) {
  // Backend sends FTS5 highlight markers «...» that correctly reflect porter-stemmed matches.
  // Guard: only use hl when it actually contains markers — plain content without «»
  // (e.g. from a title_search-only match or a FTS5 highlight edge case) should fall
  // through to the regex fallback so words are still highlighted in the text.
  if (hl && hl.includes('«')) {
    const parts = hl.split(/(«[^»]*»)/);
    return (
      <>
        {parts.map((part, i) =>
          part.startsWith('«') ? (
            <mark key={i} className="bg-yellow-300 dark:bg-yellow-500/40 text-[rgb(var(--fg))] font-bold rounded-sm px-0.5">
              {part.slice(1, -1)}
            </mark>
          ) : (
            <React.Fragment key={i}>{part}</React.Fragment>
          ),
        )}
      </>
    );
  }
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
  // When the offline corpus is loaded, every search/discourse call
  // routes through the local sqlite-wasm worker instead of the
  // FastAPI proxy. While the download is pending the engine is null
  // and the same calls fall through to /api/* — same JSON shape
  // either way, so this page doesn't need to care.
  const offlineEngine = useOfflineEngine();
  const router = useRouter();
  const searchParams = useSearchParams();

  const initialQuery = searchParams?.get('q') ?? '';
  const initialSort: Sort = (searchParams?.get('sort') as Sort) === 'title' ? 'title' : 'rank';
  const initialEvent = searchParams?.get('event') ?? '';
  const initialModeParam = searchParams?.get('mode');
  const initialMode: Mode =
    initialModeParam === 'phrase' || initialModeParam === 'near' ? initialModeParam : 'all';
  // Number(null) === 0, which passes the >= 0 guard and silently overrides
  // DEFAULT_PROX. Parse as NaN when the param is absent so the fallback fires.
  const proxStr = searchParams?.get('prox');
  const initialProxParam = proxStr !== null ? Number(proxStr) : NaN;
  const initialProx =
    Number.isFinite(initialProxParam) && initialProxParam >= 0 && initialProxParam <= 100
      ? initialProxParam
      : DEFAULT_PROX;
  const initialLang = searchParams?.get('lang') ?? '';
  const initialExact = searchParams?.get('exact') === '1';
  const initialDateFrom = searchParams?.get('from') ?? '';
  const initialDateTo = searchParams?.get('to') ?? '';

  const [query, setQuery] = useState(initialQuery);
  const [submittedQuery, setSubmittedQuery] = useState(initialQuery);
  const [mode, setMode] = useState<Mode>(initialMode);
  const [proximity, setProximity] = useState<number>(initialProx);
  const [sort, setSort] = useState<Sort>(initialSort);
  const [langFilter, setLangFilter] = useState(initialLang);
  const [exactMatch, setExactMatch] = useState<boolean>(initialExact);
  const [dateFrom, setDateFrom] = useState(initialDateFrom);
  const [dateTo, setDateTo] = useState(initialDateTo);
  const [results, setResults] = useState<SearchResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [availableLanguages, setAvailableLanguages] = useState<string[]>([]);

  const [selectedEventId, setSelectedEventId] = useState<string>(initialEvent);
  const [discourse, setDiscourse] = useState<DiscourseResponse | null>(null);
  const [discourseLoading, setDiscourseLoading] = useState(false);
  const [discourseError, setDiscourseError] = useState<string | null>(null);

  // (Hindi transliteration is now handled inline by the HindiInput component)

  const detailRef = useRef<HTMLDivElement | null>(null);
  const firstMatchRef = useRef<HTMLParagraphElement | null>(null);
  const discourseDetailsRef = useRef<HTMLDetailsElement | null>(null);

  const highlightPattern = useMemo(() => extractHighlights(submittedQuery), [submittedQuery]);

  // All paragraph indices that contain a match.
  // Primary: backend hl markers (accurate — covers stemming and NEAR proximity).
  // Fallback: client-side regex when backend didn't return hl (old server, no query).
  // hasBackendHl tells the renderer to suppress the regex fallback in non-matching
  // paragraphs when the backend provided authoritative hl markers — otherwise the
  // regex would over-highlight standalone words in NEAR queries.
  const { matchIndices, hasBackendHl } = useMemo(() => {
    if (!discourse) return { matchIndices: [] as number[], hasBackendHl: false };
    // Exclude sequence_number 0 (the title / meta row) from navigation.
    // A search term that matches the discourse title should be highlighted
    // visually but must not become a navigation stop — otherwise the arrow
    // keys halt on the title of every discourse whose name contains the
    // search word (Issue 3 regression, Sugit 2026-06-03).
    const isNavParagraph = (p: Paragraph) => p.sequence_number !== 0;
    const fromHl = discourse.paragraphs
      .map((p, idx) => (p.hl && p.hl.includes('«') && isNavParagraph(p) ? idx : -1))
      .filter((idx) => idx >= 0);
    if (fromHl.length > 0) return { matchIndices: fromHl, hasBackendHl: true };

    // For cross-paragraph NEAR queries the discourse endpoint's FTS5
    // NEAR match produces no hl markers (no single paragraph contains all
    // words within N tokens). Fall back to the search-result hit paragraphs
    // so arrow-key navigation still lands on the correct passages.
    const selectedEvent = results?.events.find((e) => e.event_id === selectedEventId);
    if (selectedEvent && selectedEvent.hits.length > 0) {
      const hitSeqs = new Set(selectedEvent.hits.map((h) => h.sequence_number));
      const fromHits = discourse.paragraphs
        .map((p, idx) => (hitSeqs.has(p.sequence_number) && isNavParagraph(p) ? idx : -1))
        .filter((idx) => idx >= 0);
      if (fromHits.length > 0) return { matchIndices: fromHits, hasBackendHl: false };
    }

    if (!highlightPattern) return { matchIndices: [] as number[], hasBackendHl: false };
    const re = new RegExp(highlightPattern.source, 'i');
    const indices = discourse.paragraphs
      .map((p, idx) => (re.test(p.content) && isNavParagraph(p) ? idx : -1))
      .filter((idx) => idx >= 0);
    return { matchIndices: indices, hasBackendHl: false };
  }, [discourse, highlightPattern, results, selectedEventId]);

  const firstMatchIndex = useMemo(() => matchIndices.length > 0 ? matchIndices[0] : -1, [matchIndices]);

  const [currentMatchPos, setCurrentMatchPos] = useState(0);
  const matchRefs = useRef<Map<number, HTMLParagraphElement>>(new Map());
  // When the user steps off the end of one discourse, we navigate to the
  // adjacent one and need the new discourse to land focused on either its
  // first or last match. The load is async (the matchIndices effect below
  // runs once the new discourse arrives), so we stash the intent here.
  const pendingJumpRef = useRef<'first' | 'last' | null>(null);

  useEffect(() => {
    if (matchIndices.length === 0) {
      setCurrentMatchPos(0);
      pendingJumpRef.current = null;
      return;
    }
    const pos =
      pendingJumpRef.current === 'last' ? matchIndices.length - 1 : 0;
    setCurrentMatchPos(pos);
    pendingJumpRef.current = null;
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

  const expandQuery = useCallback(
    (raw: string, m: Mode): { devanagari: string; searchTerm: string } => {
      // Auto-romanise Roman input only when the user is in Hindi UI AND
      // hasn't explicitly asked for English content via the language filter.
      // Without this opt-out, `Lang: English` + a Roman query produced zero
      // hits because the query was silently rewritten to Devanagari.
      // Tolerate either pill value ("English", "en", "EN") — the DB may
      // hold ISO codes instead of full names if any ingest path skipped
      // the language normalisation.
      const langKey = (langFilter || '').trim().toLowerCase();
      const explicitEnglish = langKey === 'english' || langKey === 'en';
      // In NEAR mode, only auto-transliterate if the raw query already has
      // some Devanagari — a pure-Roman NEAR query ("enlightenment trust love")
      // is almost certainly English, not romanised Hindi, so we leave it alone.
      // For all-words and phrase modes the existing behaviour is preserved.
      const rawHasDevanagari = HAS_DEVANAGARI.test(raw);
      // Don't transliterate when the query ALREADY contains Devanagari — that
      // signals a mixed-script query like "Agyat Ki Or समझाया" that must be sent
      // verbatim. Only auto-romanise pure-Latin input.
      // For NEAR mode we keep the existing guard: only transliterate when there
      // IS Devanagari already present (pure-Latin NEAR queries like
      // "enlightenment trust" are almost always English, not romanised Hindi).
      const isRoman =
        locale === 'hi' && !explicitEnglish && /[a-zA-Z]/.test(raw)
        && (m === 'near' ? rawHasDevanagari : !rawHasDevanagari);
      const devanagari = isRoman ? romanToDevanagari(raw) : raw;
      const hasDevanagari = HAS_DEVANAGARI.test(devanagari);
      const isSingleWord = !/\s/.test(devanagari.trim());
      // In exact-match mode the backend hits an un-normalised FTS index, so
      // we must NOT expand vowel-length / anusvara variants either — doing
      // so would broaden the match the user explicitly asked to narrow.
      const shouldExpand =
        !exactMatch
        && hasDevanagari
        && (m === 'all' || (m === 'phrase' && isSingleWord));
      const searchTerm = shouldExpand ? buildHindiFtsQuery(devanagari) : devanagari;
      return { devanagari, searchTerm };
    },
    [locale, langFilter, exactMatch],
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
      if (exactMatch) params.set('exact', '1');
      if (dateFrom) params.set('from', dateFrom);
      if (dateTo) params.set('to', dateTo);
      const qs = params.toString();
      router.replace(qs ? `/?${qs}` : '/', { scroll: false });
    },
    [router, langFilter, exactMatch, dateFrom, dateTo],
  );

  const runSearch = useCallback(
    async (rawQ: string, s: Sort, m: Mode, prox: number) => {
      const fts = buildQuery(rawQ, m, prox);
      if (!fts) return;
      setLoading(true);
      setError(null);
      try {
        // langFilter is a single mutually-exclusive pill. 'original' selects
        // records Osho gave originally in their language (translated_from
        // is none/NULL) regardless of language. Everything else is a literal
        // language filter (English, Hindi, …).
        const sr = await searchApi({
          q: fts,
          sort: s,
          original: langFilter === 'original',
          language: langFilter && langFilter !== 'original' ? langFilter : undefined,
          exact: exactMatch || undefined,
          dateFrom: dateFrom || undefined,
          dateTo: dateTo || undefined,
        }, offlineEngine);
        setSubmittedQuery(fts);
        setResults(sr);
        trackSearch({
          query: rawQ,
          mode: m,
          language: langFilter || 'all',
          proxDist: m === 'near' ? prox : undefined,
          resultCount: sr?.total ?? 0,
          hitCount: sr?.total_hits ?? 0,
        });
        if ((sr?.total ?? 0) === 0) trackSearchEmpty(rawQ, m);
      } catch (err) {
        setResults(null);
        setError(err instanceof Error ? err.message : 'Archive unreachable.');
      } finally {
        setLoading(false);
      }
    },
    [langFilter, dateFrom, dateTo, exactMatch, offlineEngine],
  );

  useEffect(() => {
    trackPageView(window.location.pathname + window.location.search);
    if (initialQuery) {
      const { searchTerm } = expandQuery(initialQuery, initialMode);
      void runSearch(searchTerm, initialSort, initialMode, initialProx);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // Languages list — when offline engine is ready, this comes from
    // the local DB; otherwise from /api/languages. Re-runs whenever
    // the engine becomes available so the pill list updates seamlessly.
    languagesApi(offlineEngine)
      .then((d) => { if (Array.isArray(d.languages)) setAvailableLanguages(d.languages); })
      .catch(() => {});
  }, [offlineEngine]);

  useEffect(() => {
    if (!selectedEventId) {
      setDiscourse(null);
      setDiscourseError(null);
      return;
    }
    let cancelled = false;
    setDiscourseLoading(true);
    setDiscourseError(null);
    discourseApi(
      { eventId: selectedEventId, q: submittedQuery || undefined, exact: exactMatch || undefined },
      offlineEngine,
    )
      .then((body) => {
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
  }, [selectedEventId, submittedQuery, offlineEngine]);

  const doSearch = useCallback(
    (rawQ: string) => {
      const raw = rawQ.trim();
      if (!raw) return;
      const { devanagari, searchTerm } = expandQuery(raw, mode);
      setSelectedEventId('');
      syncUrl(devanagari, sort, '', mode, proximity);
      void runSearch(searchTerm, sort, mode, proximity);
    },
    [expandQuery, mode, sort, proximity, syncUrl, runSearch],
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    doSearch(query);
  };

  const handleSortChange = (next: Sort) => {
    if (next === sort) return;
    trackSortChange(next);
    setSort(next);
    if (query.trim()) {
      const { devanagari, searchTerm } = expandQuery(query.trim(), mode);
      syncUrl(devanagari, next, selectedEventId, mode, proximity);
      void runSearch(searchTerm, next, mode, proximity);
    }
  };

  const handleModeChange = (next: Mode) => {
    if (next === mode) return;
    trackModeChange(mode, next);
    setMode(next);
    if (query.trim() && results) {
      const { devanagari, searchTerm } = expandQuery(query.trim(), next);
      syncUrl(devanagari, sort, '', next, proximity);
      setSelectedEventId('');
      void runSearch(searchTerm, sort, next, proximity);
    }
  };

  const handleProximityChange = (next: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(next || 0)));
    trackProxChange(clamped, 'input');
    setProximity(clamped);
    if (mode === 'near' && query.trim() && results) {
      const { devanagari, searchTerm } = expandQuery(query.trim(), mode);
      syncUrl(devanagari, sort, '', mode, clamped);
      setSelectedEventId('');
      void runSearch(searchTerm, sort, mode, clamped);
    }
  };

  const handleLangFilterChange = (val: string) => {
    trackLanguageFilter(val || 'all');
    setLangFilter(val);
  };

  // Re-run search + sync the URL when language filter changes. Using
  // useEffect so the search fires after React re-renders runSearch with
  // the new langFilter in its closure; the syncUrl call keeps `?lang=`
  // in step with the pill the user just clicked so reloads and back/
  // forward navigation reproduce the active filter.
  const isMountedLangRef = useRef(false);
  useEffect(() => {
    if (!isMountedLangRef.current) { isMountedLangRef.current = true; return; }
    if (query.trim()) {
      const { devanagari, searchTerm } = expandQuery(query.trim(), mode);
      syncUrl(devanagari, sort, selectedEventId, mode, proximity);
      void runSearch(searchTerm, sort, mode, proximity);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [langFilter]);

  // Same for the Exact-match toggle — flipping the pill re-issues the
  // search against the (un)stemmed index AND writes ?exact=1 to the URL
  // so the URL is a faithful record of the current view.
  const isMountedExactRef = useRef(false);
  useEffect(() => {
    if (!isMountedExactRef.current) { isMountedExactRef.current = true; return; }
    if (query.trim()) {
      const { devanagari, searchTerm } = expandQuery(query.trim(), mode);
      syncUrl(devanagari, sort, selectedEventId, mode, proximity);
      void runSearch(searchTerm, sort, mode, proximity);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [exactMatch]);

  // Debounced auto-rerun when the user edits the date range (year inputs).
  // Without this the filter looks broken: you type 1972 → nothing happens
  // until you toggle another control. 400ms is long enough to finish typing
  // a 4-digit year without firing on every keystroke.
  const isMountedDateRef = useRef(false);
  useEffect(() => {
    if (!isMountedDateRef.current) { isMountedDateRef.current = true; return; }
    if (!query.trim()) return;
    const handle = setTimeout(() => {
      const { searchTerm } = expandQuery(query.trim(), mode);
      void runSearch(searchTerm, sort, mode, proximity);
    }, 400);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dateFrom, dateTo]);

  const selectEvent = (eventId: string) => {
    if (results) {
      const ev = results.events.find(e => e.event_id === eventId);
      if (ev) trackResultClick({
        eventId,
        title: ev.title ?? eventId,
        rank: ev.rank,
        query: submittedQuery,
        mode,
      });
    }
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

  // Step one match forward / back, crossing into the adjacent discourse
  // when we're already at the end / start. Mirrors how OCTP and the
  // CD-ROM behave so a single "Next" press eventually walks through every
  // matched paragraph across every matched discourse. (Sugit 2026-05-16.)
  const jumpToMatchAcross = useCallback(
    (direction: 1 | -1) => {
      const next = currentMatchPos + direction;
      if (next >= 0 && next < matchIndices.length) {
        jumpToMatch(next);
        return;
      }
      if (!results || !results.events.length) return;
      const currentIdx = results.events.findIndex(
        (e) => e.event_id === selectedEventId,
      );
      const targetIdx = currentIdx + direction;
      if (targetIdx < 0 || targetIdx >= results.events.length) return;
      pendingJumpRef.current = direction === -1 ? 'last' : 'first';
      selectEvent(results.events[targetIdx].event_id);
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [currentMatchPos, matchIndices, jumpToMatch, results, selectedEventId],
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

  // Keyboard shortcuts:
  //   ← / →           — when the full discourse is open: navigate to the
  //                     previous / next discourse in the result list. When
  //                     only the top-matches panel is shown: step one match
  //                     back / forward, crossing into the adjacent discourse
  //                     at the boundary (Sugit 2026-05-16).
  //   j / n           — step forward, within current discourse only.
  //   k / p           — step back,   within current discourse only.
  //   Alt+↑ / Alt+↓   — jump to previous / next discourse in the result list.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      if (e.key === 'ArrowRight' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (discourseDetailsRef.current?.open) {
          navigateEvent(1);
        } else {
          jumpToMatchAcross(1);
        }
      } else if (e.key === 'ArrowLeft' && !e.altKey && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        if (discourseDetailsRef.current?.open) {
          navigateEvent(-1);
        } else {
          jumpToMatchAcross(-1);
        }
      } else if (e.key === 'n' || e.key === 'j') {
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
  }, [jumpToMatch, jumpToMatchAcross, currentMatchPos, navigateEvent]);

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
                    onSubmit={(v) => doSearch(v ?? query)}
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

            {/* Show transliteration hint for Hindi mode */}
            {locale === 'hi' && !query && (
              <div className="mt-2 text-[11px] text-stone-400 dark:text-ivory/50">
                रोमन में टाइप करो (जैसे dhyaan) → Space दबाओ → हिंदी में बदल जाएगा
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
                  {[5, 10, 30, 50].map((v) => (
                    <button
                      key={v}
                      type="button"
                      onClick={() => { trackProxChange(v, 'preset'); handleProximityChange(v); }}
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

              {/* Language filter — All / Original / EN / HI (Sugit 2026-05).
                  "Original" is a sibling option, not orthogonal: selecting it
                  filters to records Osho gave originally in their language
                  regardless of which language that was. */}
              <div className="flex items-center gap-3">
                <span className="text-stone-500 dark:text-ivory/60">
                  {locale === 'hi' ? 'भाषा' : 'Lang'}:
                </span>
                {([
                  { value: '', label: t('search.lang.all') },
                  { value: 'original', label: t('search.lang.original'), title: t('search.lang.original.tooltip') },
                  ...(availableLanguages.length ? availableLanguages : ['English', 'Hindi']).map((l) => ({ value: l, label: l })),
                ] as { value: string; label: string; title?: string }[]).map(({ value, label, title }) => (
                  <button
                    key={value || 'all'}
                    type="button"
                    onClick={() => handleLangFilterChange(value)}
                    title={title}
                    className={
                      langFilter === value
                        ? 'text-gold font-bold underline underline-offset-4 decoration-2'
                        : 'text-stone-400 dark:text-ivory/50 hover:text-[rgb(var(--fg))]'
                    }
                  >
                    {label}
                  </button>
                ))}
              </div>

              {/* Stemmed vs Exact toggle — Sugit 2026-05-16. When off
                  (default), porter stemming + Devanagari normalisation are
                  applied so "teach" matches teacher/teaching/teaches and
                  अनन्त matches अनंत. When on, the backend hits an
                  un-stemmed/un-normalised parallel FTS index so the query
                  matches literally — what OCTP and the CD-ROM do. */}
              <div className="flex items-center gap-3">
                <span className="text-stone-500 dark:text-ivory/60">
                  {t('search.exact.label')}:
                </span>
                <button
                  type="button"
                  onClick={() => setExactMatch(false)}
                  title={t('search.exact.stemmed.tooltip')}
                  className={
                    !exactMatch
                      ? 'text-gold font-bold underline underline-offset-4 decoration-2'
                      : 'text-stone-400 dark:text-ivory/50 hover:text-[rgb(var(--fg))]'
                  }
                >
                  {t('search.exact.stemmed')}
                </button>
                <span className="opacity-20">|</span>
                <button
                  type="button"
                  onClick={() => setExactMatch(true)}
                  title={t('search.exact.exact.tooltip')}
                  className={
                    exactMatch
                      ? 'text-gold font-bold underline underline-offset-4 decoration-2'
                      : 'text-stone-400 dark:text-ivory/50 hover:text-[rgb(var(--fg))]'
                  }
                >
                  {t('search.exact.exact')}
                </button>
              </div>

              {/* Date range */}
              <div className="flex items-center gap-2">
                <span className="text-stone-500 dark:text-ivory/60">
                  {locale === 'hi' ? 'काल' : 'Period'}:
                </span>
                <input
                  type="text"
                  placeholder="1942"
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

          {results?.too_many && (
            <div className="mb-4 px-3 py-2 rounded bg-amber-50 dark:bg-amber-900/20 border border-amber-300 dark:border-amber-700 text-sm text-amber-800 dark:text-amber-200">
              {locale === 'hi'
                ? `यह खोज बहुत व्यापक है — ${results.total.toLocaleString()} प्रवचन मिले। कृपया और शब्द जोड़कर खोज सीमित करें।`
                : `Query matched ${results.total.toLocaleString()} discourses — too broad to show previews. Add more specific words to narrow results.`}
            </div>
          )}

          <div className="grid grid-cols-1 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-6 md:gap-10">
            {/* Left: results list.
                `self-start` stops the CSS grid from stretching this column
                to the (often much taller) right column's height. Without it
                the section is forced to the row height and grows past its
                own content, so the scroll track runs off the bottom of the
                viewport and the handle becomes unreachable (Sugit
                2026-05-31). With self-start the column sizes to its content
                capped at max-h and scrolls internally — the same effective
                behaviour the right pane already has. */}
            <section
              aria-label="Results"
              className="self-start border border-gold/20 dark:border-gold/15 rounded-sm max-h-[calc(100vh-20rem)] overflow-y-auto"
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
                              ? 'bg-gold/15 text-gold border-l-[3px] border-gold'
                              : 'hover:bg-stone-100 dark:hover:bg-ivory/5'
                          }`}
                        >
                          <span className="flex-1 min-w-0">
                            <span className="block text-[16px] leading-snug truncate font-medium">
                              {ev.title ?? 'Untitled'}
                            </span>
                            <span className="block text-[12px] tracking-[0.1em] text-stone-500 dark:text-ivory/55 mt-1">
                              {/* Sugit/Anuragi 2026-05-21 layout: readable date,
                                  optional book title for translations (replaces
                                  the location slot), language. The technical
                                  `@time` string is no longer surfaced here. */}
                              {[
                                formatReadableDate(ev.date, locale),
                                (ev.source_short ?? '').trim() || null,
                              ].filter(Boolean).join(' · ')}
                              {ev.language && (
                                <span className="ml-1 text-[10px] tracking-[0.15em] uppercase text-gold/50">[{ev.language}]</span>
                              )}
                              {ev.hit_count > 0 && (
                                <> · <strong className="text-gold">{ev.hit_count}</strong> {locale === 'hi' ? 'अंश' : ev.hit_count === 1 ? 'hit' : 'hits'}</>
                              )}
                              {(() => {
                                const tline = translationLine(ev.translated_from, ev.source_short, locale);
                                return tline ? (
                                  <span className="block italic text-[11px] tracking-[0.05em] text-stone-500 dark:text-ivory/50 mt-0.5">
                                    {tline}
                                  </span>
                                ) : null;
                              })()}
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
              className="border border-gold/20 dark:border-gold/15 rounded-sm max-h-[calc(100vh-20rem)] overflow-y-auto"
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
                        {[
                          formatReadableDate(selectedEvent.date, locale),
                          (selectedEvent.source_short ?? '').trim() || null,
                          selectedEvent.language,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                        {selectedEvent.hit_count > 0 && (
                          <> · <strong className="text-gold">{selectedEvent.hit_count} {locale === 'hi' ? 'अंश' : 'hits'}</strong></>
                        )}
                      </div>
                      {(() => {
                        const tline = translationLine(selectedEvent.translated_from, selectedEvent.source_short, locale);
                        return tline ? (
                          <div className="italic text-[12px] tracking-[0.05em] text-stone-500 dark:text-ivory/55 mt-1">
                            {tline}
                          </div>
                        ) : null;
                      })()}
                      {selectedEvent.title && (
                        <a
                          href={`https://www.sannyas.wiki/index.php?title=${encodeURIComponent(selectedEvent.title.replace(/ /g, '_'))}`}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="inline-block mt-2 text-[11px] tracking-[0.15em] uppercase text-gold/60 hover:text-gold transition-colors"
                        >
                          sannyas.wiki ↗
                        </a>
                      )}
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
                        onClick={() => trackDiscourseOpen(selectedEvent.event_id, selectedEvent.title ?? selectedEvent.event_id, 'search')}
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
                      {selectedEvent.hits.map((h) => {
                        const roleCls = paragraphRoleClass(h.role);
                        return (
                          <li
                            key={h.paragraph_id}
                            className="bg-stone-100 dark:bg-ivory/5 border-l-[3px] border-gold/50 pl-4 pr-3 py-3 text-stone-800 dark:text-ivory/95 leading-relaxed text-[16px]"
                          >
                            <div className="text-[12px] tracking-[0.15em] uppercase text-stone-400 dark:text-ivory/40 mb-1.5 font-medium">
                              Para {h.sequence_number}
                            </div>
                            <div className={roleCls}>
                              <Highlighted text={h.content} hl={h.hl} pattern={highlightPattern} />
                            </div>
                          </li>
                        );
                      })}
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

                      <div className="mt-4 space-y-3 text-stone-800 dark:text-ivory/90 leading-relaxed text-[17px]">
                        {discourse.paragraphs.map((p, idx) => {
                          const isMatch = matchIndices.includes(idx);
                          const isCurrent = matchIndices[currentMatchPos] === idx;
                          const roleCls = paragraphRoleClass(p.role);
                          const matchCls = isCurrent
                            ? 'scroll-mt-4 ring-2 ring-gold/40 bg-gold/5 rounded-sm px-3 -mx-3 py-1'
                            : isMatch
                              ? 'scroll-mt-4 ring-1 ring-gold/15 rounded-sm px-2 -mx-2'
                              : '';
                          return (
                            <p
                              key={p.sequence_number}
                              ref={(el) => {
                                if (idx === firstMatchIndex && el) firstMatchRef.current = el;
                                if (isMatch && el) matchRefs.current.set(idx, el);
                              }}
                              className={cx(matchCls, roleCls)}
                            >
                              <Highlighted
                                text={p.content}
                                hl={p.hl}
                                pattern={hasBackendHl ? null : highlightPattern}
                              />
                            </p>
                          );
                        })}
                      </div>

                      {/* Floating hit navigation — sticks to bottom of discourse pane.
                          Prev / Next cross into the adjacent record once the current
                          record's matches are exhausted (Sugit 2026-05-16, matches
                          OCTP and CD-ROM behaviour). Buttons are only disabled when
                          we're at the very first / last match of the very first / last
                          record in the result list. */}
                      {matchIndices.length > 0 && (() => {
                        const totalEvents = results?.events.length ?? 0;
                        const atFirstEvent = selectedIdx <= 0;
                        const atLastEvent = selectedIdx >= totalEvents - 1;
                        const atFirstMatch = currentMatchPos <= 0;
                        const atLastMatch = currentMatchPos >= matchIndices.length - 1;
                        const prevDisabled = atFirstMatch && atFirstEvent;
                        const nextDisabled = atLastMatch && atLastEvent;
                        return (
                          <div className="sticky bottom-3 z-20 mt-6 flex justify-center pointer-events-none">
                            <div className="pointer-events-auto flex items-center gap-1 text-[11px] tracking-[0.2em] uppercase backdrop-blur-md bg-[rgb(var(--bg))]/85 border border-gold/40 rounded-full px-2 py-1 shadow-lg shadow-black/20">
                              <button
                                type="button"
                                onClick={() => jumpToMatchAcross(-1)}
                                disabled={prevDisabled}
                                className="px-2.5 py-1 text-gold hover:bg-gold/10 rounded-full disabled:opacity-30 transition-colors font-medium"
                                aria-label={locale === 'hi' ? 'पिछला' : 'Previous match'}
                                title={locale === 'hi' ? 'पिछला मिलान (←)' : 'Previous match (←)'}
                              >
                                ← {locale === 'hi' ? 'पिछला' : 'Prev'}
                              </button>
                              <span className="text-stone-500 dark:text-ivory/70 tabular-nums font-medium px-1.5">
                                {currentMatchPos + 1} / {matchIndices.length}
                                {totalEvents > 1 && (
                                  <span className="opacity-50">  · {selectedIdx + 1}/{totalEvents}</span>
                                )}
                              </span>
                              <button
                                type="button"
                                onClick={() => jumpToMatchAcross(1)}
                                disabled={nextDisabled}
                                className="px-2.5 py-1 text-gold hover:bg-gold/10 rounded-full disabled:opacity-30 transition-colors font-medium"
                                aria-label={locale === 'hi' ? 'अगला' : 'Next match'}
                                title={locale === 'hi' ? 'अगला मिलान (→)' : 'Next match (→)'}
                              >
                                {locale === 'hi' ? 'अगला' : 'Next'} →
                              </button>
                            </div>
                          </div>
                        );
                      })()}
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
