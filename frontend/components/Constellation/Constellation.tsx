'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Event {
  id: string;
  title: string | null;
  date: string | null;
  location: string | null;
  language?: string | null;
  tags?: string[];
}

// ─── Comprehensive Theme Classification ───────────────────────────────────────
// All ~200 Osho series mapped — nothing lands in "Other" if we can help it.
// Order matters: more specific traditions first; first match wins.

const THEMES: { name: string; color: string; bg: string; keys: string[] }[] = [
  {
    name: 'Zen & Buddhism',
    color: '#10b981',
    bg: 'rgba(16,185,129,0.08)',
    keys: [
      'zen', 'dhammapada', 'bodhidharma', 'hui neng', 'huang po',
      'hsin hsin', 'no water no moon', 'white lotus', 'dang dang',
      'this very body the buddha', 'grass grows', 'sudden clash',
      'sandokai', 'ah, this', 'ah this', 'take it easy', 'atisha',
      'nagarjuna', 'book of wisdom', 'returning to the source',
      'communism and zen', 'the buddha said', 'nirvana', 'ma tzu',
      'the further shore', 'rinzai', 'prajna', 'flash of lightning',
      'one seed makes', 'the miracle', 'walking in zen', 'nansen',
      'language of existence', 'and the flowers showered',
      'om mani padme hum', 'diamond sutra', 'heart sutra',
      'no mind: the flowers', 'the search', 'zen fire',
      'isan', 'yakusan', 'the beloved (nansen)',
    ],
  },
  {
    name: 'Vedanta & Upanishads',
    color: '#f97316',
    bg: 'rgba(249,115,22,0.08)',
    keys: [
      'vedanta', 'upanishad', 'shankara', 'ashtavakra',
      'yoga vasistha', 'mahageeta', 'sarvasar', 'brihadaranyaka',
      'supreme doctrine', 'isha upanishad', 'bhagavad', 'geeta', 'gita',
      'krishna', 'that art thou', 'the ultimate alchemy',
      'philosophia ultima', 'mandukya', 'vivekachudamani',
      'the eternal quest', 'the supreme mystery',
    ],
  },
  {
    name: 'Tantra & Shaivism',
    color: '#ef4444',
    bg: 'rgba(239,68,68,0.08)',
    keys: [
      'tantra', 'vigyan', 'bhairav', 'shiva sutra', 'book of secrets',
      'shakti', 'tantric', 'tilopa', 'mahamudra', 'tantric transformation',
      'supreme understanding',
    ],
  },
  {
    name: 'Yoga',
    color: '#84cc16',
    bg: 'rgba(132,204,22,0.08)',
    keys: [
      'yoga:', 'yoga ', 'patanjali', 'kundalini', 'pranayama',
      'the path of yoga', 'yoga alpha', 'yoga mystery',
      'in search of the miraculous',
    ],
  },
  {
    name: 'Taoism',
    color: '#06b6d4',
    bg: 'rgba(6,182,212,0.08)',
    keys: [
      'tao:', ' tao ', 'taoism', 'taoist', 'chuang tzu', 'chuang-tzu',
      'lao tzu', 'lieh tzu', 'empty boat', 'when the shoe fits',
      'the secret of secrets', 'tao: the golden gate', 'ko hsuan',
    ],
  },
  {
    name: 'Sufism',
    color: '#8b5cf6',
    bg: 'rgba(139,92,246,0.08)',
    keys: [
      'sufi', 'rumi', 'farid', 'sanai', 'khayyam', 'mansoor', 'mevlana',
      'unio mystica', 'perfect master', 'until you die', 'just like that',
      'the beloved', 'wisdom of the sands', 'come come yet again',
      'the secret (rumi)', 'haditqat', 'fire, the woman',
      'sufis: the people',
    ],
  },
  {
    name: 'Christianity',
    color: '#a78bfa',
    bg: 'rgba(167,139,250,0.08)',
    keys: [
      'jesus', 'christ', 'christian', 'gospel', 'testament',
      'mustard seed', 'come follow me', 'i say unto',
      'lazarus', 'sermon on the mount', 'thomas', 'beatitude',
      'theologia mystica', 'dionysius', 'i am the gate',
    ],
  },
  {
    name: 'Bhakti & Saints',
    color: '#f43f5e',
    bg: 'rgba(244,63,94,0.08)',
    keys: [
      'kabir', 'meera', 'mira', 'nanak', 'tukaram', 'mirabai',
      'bhakti', 'divine melody', 'path of love', 'ecstasy: the forgotten',
      'immortal friend', 'nowhere to go but in', 'sant',
      'sahajo', 'daya', 'showering without clouds', 'the long lost friend',
      'the mystic rose', 'the true name',
    ],
  },
  {
    name: 'Jainism & Indian Mysticism',
    color: '#fb923c',
    bg: 'rgba(251,146,60,0.08)',
    keys: [
      'mahavira', 'jain', 'mrityu', 'jeevan', 'sambodhi',
      'anand ki', 'kaun hai', 'main mrityu', 'mahaveer',
      'the great courageous', 'adinath', 'samadhi ke', 'mera sone',
      'main kahta', 'jeevan sangeet', 'yog sutra',
    ],
  },
  {
    name: 'Philosophy & Psychology',
    color: '#3b82f6',
    bg: 'rgba(59,130,246,0.08)',
    keys: [
      'philosoph', 'nietzsche', 'heraclitus', 'socrates', 'plato',
      'gurdjieff', 'pythagoras', 'zarathustra', 'spinoza',
      'occult', 'esoteric', 'alchemy', 'freud', 'jung',
      'the hidden harmony', 'the true sage', 'hasid',
      'psychology', 'the god conspiracy', 'the new man',
      'the rebel', 'the book of man', 'the golden future',
    ],
  },
  {
    name: 'Love & Society',
    color: '#ec4899',
    bg: 'rgba(236,72,153,0.08)',
    keys: [
      'love', 'intimacy', 'relationship', 'sex', 'marriage',
      'man and woman', 'freedom', 'courage', 'creativity',
      'intelligence', 'maturity', 'aloneness',
      'the goose is out', 'the rajneesh bible',
      'a new vision of women', 'the abc of enlightenment',
    ],
  },
  {
    name: 'Meditation & Consciousness',
    color: '#f59e0b',
    bg: 'rgba(245,158,11,0.08)',
    keys: [
      'meditation', 'dhyan', 'silence', 'awareness', 'no-mind',
      'witness', 'samadhi', 'emptiness', 'nothingness',
      'consciousness', 'enlighten', 'art of dying',
      'transmission of the lamp', 'from darkness to light',
      'from unconsciousness', 'the razor', 'hidden splendor',
      'light on the path', 'beyond psychology', 'new alchemy',
      'transformation', 'from death to deathlessness',
      'the sword and the lotus', 'the osho upanishad',
      'beyond enlightenment', 'the new dawn', 'the invitation',
      'om shantih', 'hari om', 'sat chit', 'the rebellious spirit',
      'the path is the goal', 'the wild geese',
      'come without knocking', 'sermons in stones',
      'the discipline of transcendence',
    ],
  },
  // Catch-all — only reaches here if none of the above matched
  {
    name: 'Daily Discourses',
    color: '#94a3b8',
    bg: 'rgba(148,163,184,0.08)',
    keys: [],
  },
];

// ─── Era definitions ──────────────────────────────────────────────────────────

// Osho's first recorded talks were at meditation camps from the mid-1950s,
// while he was a professor in Jabalpur. The full arc of his teaching life:
//   Early period  1942–1968  Gadarwara, Jabalpur, all-India camps
//   Bombay        1969–1973  moved to Bombay, early ashram followers
//   Poona I       1974–1981  Shree Rajneesh Ashram
//   Oregon        1981–1985  Rajneeshpuram commune
//   World Tour    1985–1986  Uruguay, Greece, Portugal, UK, etc.
//   Poona II      1987–1990  return to Pune as Osho
const ERAS: { name: string; label: string; from: number; to: number; color: string }[] = [
  { name: 'Early',    label: 'Early  1942–1968',      from: 1900, to: 1968, color: '#a3a3a3' },
  { name: 'Bombay',   label: 'Bombay  1969–1973',     from: 1969, to: 1973, color: '#60a5fa' },
  { name: 'Poona I',  label: 'Poona I  1974–1981',    from: 1974, to: 1980, color: '#d4af37' },
  { name: 'Oregon',   label: 'Oregon  1981–1985',     from: 1981, to: 1985, color: '#ef4444' },
  { name: 'World Tour', label: 'World Tour  1985–1986', from: 1985, to: 1986, color: '#8b5cf6' },
  { name: 'Poona II', label: 'Poona II  1987–1990',   from: 1987, to: 1995, color: '#10b981' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function yearOf(date: string | null): number | null {
  const y = (date ?? '').slice(0, 4);
  return /^\d{4}$/.test(y) ? parseInt(y, 10) : null;
}

function eraOf(year: number | null): string {
  if (!year) return '';
  for (const e of ERAS) if (year >= e.from && year <= e.to) return e.name;
  return '';
}

function seriesOf(title: string | null): string {
  if (!title) return 'Untitled';
  const i = title.indexOf(' ~ ');
  return i >= 0 ? title.slice(0, i) : title;
}

function themeOf(title: string | null): (typeof THEMES)[0] {
  if (!title) return THEMES[THEMES.length - 1];
  const s = seriesOf(title).toLowerCase();
  for (const theme of THEMES) {
    if (theme.keys.length > 0 && theme.keys.some((k) => s.includes(k)))
      return theme;
  }
  return THEMES[THEMES.length - 1];
}

// ─── Derived series type ──────────────────────────────────────────────────────

// Normalise a free-text location string to a short city/region label
function cityLabel(loc: string | null | undefined): string {
  if (!loc) return '';
  const l = loc.toLowerCase();
  if (l.includes('rajneeshpuram') || l.includes('oregon')) return 'Oregon';
  if (l.includes('pune') || l.includes('poona')) return 'Pune';
  if (l.includes('bombay') || l.includes('mumbai')) return 'Bombay';
  if (l.includes('kathmandu')) return 'Kathmandu';
  if (l.includes('jabalpur')) return 'Jabalpur';
  if (l.includes('mount abu') || l.includes('mt. abu') || l.includes('mt abu')) return 'Mt. Abu';
  if (l.includes('gadarwara')) return 'Gadarwara';
  if (l.includes('uruguay') || l.includes('montevideo')) return 'Uruguay';
  if (l.includes('crete') || l.includes('knossos')) return 'Crete';
  if (l.includes('greece')) return 'Greece';
  if (l.includes('portugal')) return 'Portugal';
  if (l.includes('world tour')) return 'World Tour';
  if (l.includes('india')) return 'India';
  // Return first meaningful token otherwise
  const first = loc.split(',')[0].trim();
  return first.length < 30 ? first : '';
}

interface Series {
  name: string;
  theme: (typeof THEMES)[0];
  era: string;
  talks: Event[];
  year: number | null;
  yearMax: number | null;
  location: string;   // normalised city label, '' if unknown
  tags: string[];     // aggregated topic tags across all talks in series
  language: string;   // 'English' | 'Hindi' | 'Mixed' | ''
}

function buildSeries(events: Event[]): Series[] {
  const map = new Map<string, Event[]>();
  for (const ev of events) {
    const s = seriesOf(ev.title);
    if (!map.has(s)) map.set(s, []);
    map.get(s)!.push(ev);
  }
  const out: Series[] = [];
  for (const [name, talks] of Array.from(map)) {
    const years = talks
      .map((t) => yearOf(t.date))
      .filter((y): y is number => y !== null)
      .sort();
    const year    = years.length ? years[0] : null;
    const yearMax = years.length ? years[years.length - 1] : null;

    // Derive location from talks (prefer non-null)
    const locCounts: Record<string, number> = {};
    for (const t of talks) {
      const c = cityLabel(t.location);
      if (c) locCounts[c] = (locCounts[c] ?? 0) + 1;
    }
    const location = Object.entries(locCounts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';

    // Aggregate tags across all talks in series, rank by frequency
    const tagFreq: Record<string, number> = {};
    for (const t of talks) {
      for (const tag of t.tags ?? []) tagFreq[tag] = (tagFreq[tag] ?? 0) + 1;
    }
    const tags = Object.entries(tagFreq)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 6)
      .map(([tag]) => tag);

    // Language
    const langs = new Set(talks.map((t) => t.language).filter(Boolean));
    const language =
      langs.size === 0 ? '' :
      langs.size > 1   ? 'Mixed' :
      Array.from(langs)[0] as string;

    out.push({
      name,
      theme: themeOf(name),
      era: eraOf(year),
      talks: talks.sort((a, b) => (a.title ?? '').localeCompare(b.title ?? '')),
      year,
      yearMax,
      location,
      tags,
      language,
    });
  }
  return out.sort((a, b) => (a.year ?? 9999) - (b.year ?? 9999));
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function EraBar({
  series,
  activeEra,
  onEra,
}: {
  series: Series[];
  activeEra: string;
  onEra: (era: string) => void;
}) {
  const counts = useMemo(() => {
    const c: Record<string, { series: number; talks: number }> = {};
    for (const e of ERAS) c[e.name] = { series: 0, talks: 0 };
    for (const s of series) {
      if (s.era && c[s.era]) {
        c[s.era].series++;
        c[s.era].talks += s.talks.length;
      }
    }
    return c;
  }, [series]);

  const totalTalks = series.reduce((n, s) => n + s.talks.length, 0);

  return (
    <div className="mb-6">
      <div className="flex flex-wrap gap-2">
        <button
          onClick={() => onEra('')}
          className={`px-4 py-2 rounded text-[12px] tracking-[0.15em] uppercase font-medium transition-colors ${
            activeEra === ''
              ? 'bg-gold text-black'
              : 'border border-gold/30 text-stone-500 dark:text-ivory/60 hover:border-gold/60'
          }`}
        >
          All eras · {totalTalks.toLocaleString()} talks
        </button>
        {ERAS.map((era) => {
          const c = counts[era.name];
          const active = activeEra === era.name;
          return (
            <button
              key={era.name}
              onClick={() => onEra(active ? '' : era.name)}
              style={active ? { backgroundColor: era.color, color: '#000' } : { borderColor: era.color + '60' }}
              className={`px-4 py-2 rounded text-[12px] tracking-[0.12em] uppercase font-medium transition-colors border ${
                active ? '' : 'text-stone-500 dark:text-ivory/60 hover:opacity-80'
              }`}
            >
              {era.label} · {c.talks}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function ThemeFilters({
  series,
  activeThemes,
  onTheme,
}: {
  series: Series[];
  activeThemes: Set<string>;
  onTheme: (name: string) => void;
}) {
  const counts = useMemo(() => {
    const c: Record<string, number> = {};
    for (const s of series) c[s.theme.name] = (c[s.theme.name] ?? 0) + 1;
    return c;
  }, [series]);

  return (
    <div className="flex flex-wrap gap-1.5 mb-6">
      {THEMES.map((theme) => {
        if (!counts[theme.name]) return null;
        const active = activeThemes.has(theme.name);
        return (
          <button
            key={theme.name}
            onClick={() => onTheme(theme.name)}
            style={{
              borderColor: theme.color + (active ? 'ff' : '50'),
              backgroundColor: active ? theme.color : theme.bg,
              color: active ? '#000' : theme.color,
            }}
            className="px-3 py-1 rounded-full text-[11px] tracking-[0.1em] uppercase font-medium transition-all border"
          >
            {theme.name} <span className="opacity-70 ml-1">{counts[theme.name]}</span>
          </button>
        );
      })}
    </div>
  );
}

function SeriesCard({
  s, isOpen, onToggle, onTag,
}: {
  s: Series;
  isOpen: boolean;
  onToggle: () => void;
  onTag: (tag: string) => void;
}) {
  const yearRange =
    s.year
      ? s.yearMax && s.yearMax !== s.year
        ? `${s.year}–${s.yearMax}`
        : `${s.year}`
      : null;

  return (
    <div
      className="border border-gold/15 rounded-sm overflow-hidden transition-shadow hover:shadow-md bg-[rgb(var(--bg))]"
      style={{ borderLeftColor: s.theme.color, borderLeftWidth: 3 }}
    >
      <button
        type="button"
        onClick={onToggle}
        className="w-full text-left px-4 py-3.5"
      >
        <div className="flex items-start justify-between gap-2">
          <div className="text-[15px] font-medium leading-snug text-[rgb(var(--fg))] line-clamp-2 flex-1">
            {s.name}
          </div>
          <span className="text-gold/50 flex-shrink-0 text-[18px] leading-none mt-0.5">
            {isOpen ? '−' : '+'}
          </span>
        </div>

        {/* Meta row */}
        <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 mt-1.5">
          <span
            className="text-[10px] tracking-[0.12em] uppercase font-medium px-1.5 py-0.5 rounded"
            style={{ backgroundColor: s.theme.bg, color: s.theme.color }}
          >
            {s.theme.name}
          </span>
          {yearRange && (
            <span className="text-[11px] text-stone-400 dark:text-ivory/45">{yearRange}</span>
          )}
          {s.location && (
            <span className="text-[11px] text-stone-400 dark:text-ivory/45">{s.location}</span>
          )}
          {s.language && s.language !== 'English' && (
            <span className="text-[10px] tracking-[0.1em] uppercase px-1 py-0.5 rounded bg-stone-100 dark:bg-ivory/5 text-stone-500 dark:text-ivory/50">
              {s.language}
            </span>
          )}
          <span className="text-[11px] text-stone-400 dark:text-ivory/45">
            {s.talks.length} {s.talks.length === 1 ? 'talk' : 'talks'}
          </span>
        </div>

        {/* Topic tags */}
        {s.tags.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {s.tags.slice(0, 5).map((tag) => (
              <span
                key={tag}
                onClick={(e) => { e.stopPropagation(); onTag(tag); }}
                className="text-[10px] px-1.5 py-0.5 rounded border border-gold/20 text-stone-500 dark:text-ivory/45 hover:border-gold/60 hover:text-gold cursor-pointer transition-colors"
              >
                {tag}
              </span>
            ))}
          </div>
        )}
      </button>

      {isOpen && (
        <div
          className="border-t border-gold/10 px-4 py-3 space-y-1 max-h-72 overflow-y-auto"
          style={{ backgroundColor: s.theme.bg }}
        >
          {s.talks.map((ev) => (
            <div key={ev.id} className="flex items-center justify-between gap-2 group">
              <Link
                href={`/read?event_id=${encodeURIComponent(ev.id)}`}
                className="text-[13px] text-stone-700 dark:text-ivory/80 hover:text-gold truncate flex-1"
              >
                {ev.title ?? 'Untitled'}
              </Link>
              <span className="text-[11px] text-stone-400 dark:text-ivory/40 flex-shrink-0 tabular-nums">
                {(ev.date ?? '').slice(0, 4)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Constellation() {
  const [events,  setEvents]  = useState<Event[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [activeEra, setActiveEra] = useState('');
  const [activeThemes, setActiveThemes] = useState<Set<string>>(new Set());
  const [activeTags, setActiveTags] = useState<Set<string>>(new Set());
  const [activeLang, setActiveLang] = useState('');
  const [search, setSearch] = useState('');
  const [sort, setSort] = useState<'date' | 'name' | 'size'>('date');
  const [openSeries, setOpenSeries] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/catalog', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { events: Event[] }) => { setEvents(d.events); setLoading(false); })
      .catch(() => { setError('Could not load archive.'); setLoading(false); });
  }, []);

  const allSeries = useMemo(() => buildSeries(events), [events]);

  // Year range across all talks
  const [yearMin, yearMax] = useMemo(() => {
    const years = events.map((e) => yearOf(e.date)).filter((y): y is number => y !== null);
    return years.length ? [Math.min(...years), Math.max(...years)] : [null, null];
  }, [events]);

  // All available topic tags across all series (sorted by frequency)
  const allTags = useMemo(() => {
    const freq: Record<string, number> = {};
    for (const s of allSeries) for (const t of s.tags) freq[t] = (freq[t] ?? 0) + s.talks.length;
    return Object.entries(freq).sort((a, b) => b[1] - a[1]).map(([tag]) => tag);
  }, [allSeries]);

  // All available languages
  const allLangs = useMemo(() => {
    const s = new Set(allSeries.map((x) => x.language).filter(Boolean));
    return Array.from(s).sort();
  }, [allSeries]);

  // Apply filters
  const filtered = useMemo(() => {
    let s = allSeries;
    if (activeEra)             s = s.filter((x) => x.era === activeEra);
    if (activeThemes.size > 0) s = s.filter((x) => activeThemes.has(x.theme.name));
    if (activeTags.size > 0)   s = s.filter((x) => Array.from(activeTags).every((t) => x.tags.includes(t)));
    if (activeLang)            s = s.filter((x) => x.language === activeLang || x.language === 'Mixed');
    if (search.trim())         s = s.filter((x) => x.name.toLowerCase().includes(search.toLowerCase()));
    return s;
  }, [allSeries, activeEra, activeThemes, activeTags, activeLang, search]);

  const sorted = useMemo(() => {
    const c = [...filtered];
    if (sort === 'name') c.sort((a, b) => a.name.localeCompare(b.name));
    else if (sort === 'size') c.sort((a, b) => b.talks.length - a.talks.length);
    return c;
  }, [filtered, sort]);

  function toggleTheme(name: string) {
    setActiveThemes((prev) => {
      const next = new Set(prev);
      next.has(name) ? next.delete(name) : next.add(name);
      return next;
    });
  }

  function toggleTag(tag: string) {
    setActiveTags((prev) => {
      const next = new Set(prev);
      next.has(tag) ? next.delete(tag) : next.add(tag);
      return next;
    });
  }

  const hasFilters = activeEra || activeThemes.size > 0 || activeTags.size > 0 || activeLang || search;
  const totalTalks = sorted.reduce((n, s) => n + s.talks.length, 0);

  if (loading) {
    return (
      <main className="max-w-5xl mx-auto px-4 py-12 text-center text-stone-500 dark:text-ivory/60">
        Loading archive…
      </main>
    );
  }
  if (error) {
    return (
      <main className="max-w-5xl mx-auto px-4 py-12 text-center text-red-500">
        {error}
      </main>
    );
  }

  return (
    <main className="max-w-5xl mx-auto px-4 py-8">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-medium text-gold tracking-wide mb-1">
          The Complete Library
        </h1>
        <p className="text-[13px] text-stone-500 dark:text-ivory/55">
          {allSeries.length} discourse series · {events.length.toLocaleString()} total talks · {yearMin}–{yearMax}
        </p>
      </div>

      {/* Era selector */}
      <EraBar series={allSeries} activeEra={activeEra} onEra={setActiveEra} />

      {/* Theme filters */}
      <ThemeFilters series={allSeries} activeThemes={activeThemes} onTheme={toggleTheme} />

      {/* Topic tag chips — only shown once build_tags.py has been run */}
      {allTags.length > 0 && (
        <div className="mb-5">
          <div className="text-[10px] tracking-[0.2em] uppercase text-stone-400 dark:text-ivory/40 mb-2">
            Topics
          </div>
          <div className="flex flex-wrap gap-1.5">
            {allTags.map((tag) => {
              const active = activeTags.has(tag);
              return (
                <button
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className={`px-2.5 py-0.5 rounded-full text-[11px] border transition-all ${
                    active
                      ? 'border-gold bg-gold/15 text-gold'
                      : 'border-gold/20 text-stone-500 dark:text-ivory/45 hover:border-gold/50'
                  }`}
                >
                  {tag}
                </button>
              );
            })}
          </div>
        </div>
      )}

      {/* Controls row */}
      <div className="flex flex-wrap items-center gap-3 mb-5">
        {/* Search */}
        <input
          type="search"
          placeholder="Filter series…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="flex-1 min-w-[160px] max-w-xs px-3 py-1.5 text-[13px] border border-gold/25 rounded bg-transparent text-[rgb(var(--fg))] placeholder-stone-400 dark:placeholder-ivory/35 focus:outline-none focus:border-gold/60"
        />

        {/* Language */}
        {allLangs.length > 1 && (
          <div className="flex items-center gap-1 text-[11px] tracking-[0.12em] uppercase">
            {['', ...allLangs].map((l) => (
              <button
                key={l || 'all'}
                onClick={() => setActiveLang(l)}
                className={`px-2.5 py-1 rounded transition-colors ${
                  activeLang === l
                    ? 'bg-gold/20 text-gold'
                    : 'text-stone-400 dark:text-ivory/40 hover:text-gold'
                }`}
              >
                {l || 'All'}
              </button>
            ))}
          </div>
        )}

        {/* Sort */}
        <div className="flex items-center gap-1 text-[11px] tracking-[0.12em] uppercase">
          <span className="text-stone-400 dark:text-ivory/40 mr-1">Sort</span>
          {(['date', 'name', 'size'] as const).map((s) => (
            <button
              key={s}
              onClick={() => setSort(s)}
              className={`px-2.5 py-1 rounded transition-colors ${
                sort === s
                  ? 'bg-gold/20 text-gold'
                  : 'text-stone-400 dark:text-ivory/40 hover:text-gold'
              }`}
            >
              {s}
            </button>
          ))}
        </div>

        {/* Clear */}
        {hasFilters && (
          <button
            onClick={() => {
              setActiveEra(''); setActiveThemes(new Set());
              setActiveTags(new Set()); setActiveLang(''); setSearch('');
            }}
            className="text-[11px] tracking-[0.1em] uppercase text-stone-400 hover:text-gold"
          >
            Clear filters
          </button>
        )}

        {/* Count */}
        <span className="ml-auto text-[12px] text-stone-400 dark:text-ivory/40">
          {sorted.length} series · {totalTalks.toLocaleString()} talks
        </span>
      </div>

      {/* Series grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
        {sorted.map((s) => (
          <SeriesCard
            key={s.name}
            s={s}
            isOpen={openSeries === s.name}
            onToggle={() => setOpenSeries(openSeries === s.name ? null : s.name)}
            onTag={toggleTag}
          />
        ))}
      </div>

      {sorted.length === 0 && (
        <div className="text-center py-16 text-stone-500 dark:text-ivory/50">
          No series match the current filters.
        </div>
      )}
    </main>
  );
}
