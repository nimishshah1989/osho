'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
import { useLocale } from '../../lib/i18n';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Event {
  id: string;
  title: string;
  date: string | null;
  location: string | null;
}

interface CatalogResponse {
  events: Event[];
}

interface SelectedItem {
  heading: string;
  subheading: string;
  color: string;
  events: Event[];
}

// ─── Themes ───────────────────────────────────────────────────────────────────
// Order matters — first match wins. More specific traditions come first.

const THEMES: { name: string; keys: string[]; color: string }[] = [
  {
    name: 'Zen & Buddhism',
    color: '#10b981',
    keys: [
      'zen', 'dhammapada', 'bodhidharma', 'hui neng', 'huang po',
      'hsin hsin', 'no water no moon', 'white lotus', 'dang dang',
      'this very body the buddha', 'grass grows', 'sudden clash',
      'sandokai', 'ah, this', 'ah this', 'take it easy', 'atisha',
      'nagarjuna', 'book of wisdom', 'no mind: the flowers',
      'returning to the source', 'communism and zen', 'the buddha said',
      'buddhism', 'buddhist', 'nirvana', 'ma tzu', 'isan', 'yakusan',
      'the further shore', 'rinzai', 'prajna', 'flash of lightning',
      'one seed makes', 'the miracle',
    ],
  },
  {
    name: 'Vedanta & Upanishads',
    color: '#f97316',
    keys: [
      'vedanta', 'upanishad', 'shankara', 'ashtavakra',
      'yoga vasistha', 'mahageeta', 'sarvasar', 'brihadaranyaka',
      'supreme doctrine', 'isha upanishad', 'bhagavad',
      'geeta', 'gita', 'krishna',
    ],
  },
  {
    name: 'Tantra',
    color: '#ef4444',
    keys: [
      'tantra', 'vigyan', 'bhairav', 'shiva sutra',
      'book of secrets', 'shakti', 'tantric',
    ],
  },
  {
    name: 'Yoga',
    color: '#84cc16',
    keys: ['yoga', 'patanjali', 'kundalini', 'chakra', 'pranayama'],
  },
  {
    name: 'Taoism',
    color: '#06b6d4',
    keys: [
      'tao:', ' tao', 'taoism', 'taoist',
      'chuang tzu', 'chuang-tzu', 'lao tzu', 'lieh tzu', 'empty boat',
    ],
  },
  {
    name: 'Sufism',
    color: '#8b5cf6',
    keys: [
      'sufi', 'rumi', 'farid', 'sanai', 'khayyam', 'mansoor',
      'mevlana', 'unio mystica', 'perfect master',
      'until you die', 'just like that',
    ],
  },
  {
    name: 'Christianity',
    color: '#a78bfa',
    keys: [
      'jesus', 'christ', 'christian', 'gospel', 'testament',
      'mustard seed', 'come follow me', 'i say unto',
      'lazarus', 'sermon on the mount', 'thomas', 'beatitude',
    ],
  },
  {
    name: 'Bhakti & Saints',
    color: '#f43f5e',
    keys: [
      'kabir', 'meera', 'mira', 'nanak', 'tukaram', 'mirabai',
      'bhakti', 'divine melody', 'path of love',
      'ecstasy: the forgotten', 'immortal friend',
      'the beloved', 'nowhere to go but in', 'sant',
    ],
  },
  {
    name: 'Love & Relating',
    color: '#ec4899',
    keys: [
      'love', 'intimacy', 'relationship', 'sex', 'marriage',
      'man and woman', 'eros', 'eroticism',
    ],
  },
  {
    name: 'Philosophy & Esoteric',
    color: '#3b82f6',
    keys: [
      'philosoph', 'nietzsche', 'heraclitus', 'socrates', 'plato',
      'gurdjieff', 'pythagoras', 'zarathustra', 'spinoza',
      'occult', 'esoteric', 'alchemy', 'freud', 'jung',
      'the hidden harmony', 'the true sage', 'hasid',
    ],
  },
  {
    name: 'Meditation & Consciousness',
    color: '#f59e0b',
    keys: [
      'meditation', 'dhyan', 'silence', 'awareness', 'no-mind',
      'no mind', 'witness', 'samadhi', 'emptiness', 'nothingness',
      'consciousness', 'enlighten', 'art of dying',
      'transmission of the lamp', 'from darkness to light',
      'from unconsciousness', 'the razor', 'hidden splendor',
      'light on the path', 'beyond psychology', 'new alchemy',
      'transformation', 'from death to deathlessness',
      'the sword and the lotus', 'the osho upanishad',
    ],
  },
  {
    name: 'Other',
    color: '#94a3b8',
    keys: [],
  },
];

// ─── Location mapping ─────────────────────────────────────────────────────────

const KNOWN_CITIES: { match: RegExp; name: string }[] = [
  { match: /\brajneeshpuram\b|\boregon\b/i,               name: 'Rajneeshpuram' },
  { match: /\bpoona\b|\bpune\b/i,                         name: 'Pune' },
  { match: /\bbombay\b|\bmumbai\b/i,                      name: 'Bombay' },
  { match: /\bkathmandu\b/i,                              name: 'Kathmandu' },
  { match: /\bjabalpur\b/i,                               name: 'Jabalpur' },
  { match: /\bahmedabad\b/i,                              name: 'Ahmedabad' },
  { match: /\bmt\.?\s*abu\b|\bmount\s*abu\b/i,            name: 'Mt. Abu' },
  { match: /\bgadarwara\b/i,                              name: 'Gadarwara' },
  { match: /\buruguay\b|\bmontevideo\b/i,                 name: 'Uruguay' },
  { match: /\bcrete\b|\bknossos\b/i,                      name: 'Crete' },
  { match: /\bgreece\b|\bathens\b|\bdelphi\b/i,           name: 'Greece' },
  { match: /\bportugal\b|\blisbon\b|\bsintra\b/i,         name: 'Portugal' },
  { match: /\bjamaica\b|\bkingston\b/i,                   name: 'Jamaica' },
  { match: /\bnetherlands\b|\bholland\b|\bamsterdam\b/i,  name: 'Netherlands' },
  { match: /\bireland\b|\bdublin\b/i,                     name: 'Ireland' },
  { match: /\bengland\b|\blondon\b|\buk\b/i,              name: 'UK' },
  { match: /\bspain\b|\bmadrid\b|\bbarcelona\b/i,         name: 'Spain' },
  { match: /\bcanada\b|\btoronto\b|\bvancouver\b/i,       name: 'Canada' },
  { match: /\bnepal\b/i,                                  name: 'Nepal' },
  { match: /\bmanali\b/i,                                 name: 'Manali' },
  { match: /\bnargol\b/i,                                 name: 'Nargol' },
  { match: /\bdelhi\b/i,                                  name: 'Delhi' },
  { match: /\bdwarka\b/i,                                 name: 'Dwarka' },
  { match: /\bkashmir\b/i,                                name: 'Kashmir' },
  { match: /\bnagpur\b/i,                                 name: 'Nagpur' },
  { match: /\bsurat\b/i,                                  name: 'Surat' },
  { match: /\bbaroda\b|\bvadodara\b/i,                    name: 'Baroda' },
  { match: /\bbangalore\b|\bbengaluru\b/i,                name: 'Bangalore' },
  { match: /\bgoa\b/i,                                    name: 'Goa' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function yearOf(date: string | null): number | null {
  const y = (date ?? '').slice(0, 4);
  return /^\d{4}$/.test(y) ? parseInt(y, 10) : null;
}

function cityOf(loc: string | null): string | null {
  if (!loc) return null;
  for (const c of KNOWN_CITIES) if (c.match.test(loc)) return c.name;
  return null;
}

function seriesOf(title: string): string {
  const i = title.indexOf(' ~ ');
  return i >= 0 ? title.slice(0, i) : title;
}

function themeOf(title: string): string {
  const s = seriesOf(title).toLowerCase();
  for (const theme of THEMES) {
    if (theme.keys.length > 0 && theme.keys.some((k) => s.includes(k))) {
      return theme.name;
    }
  }
  return 'Other';
}

function colorOfTheme(name: string): string {
  return THEMES.find((t) => t.name === name)?.color ?? '#94a3b8';
}

// ─── Data interfaces ──────────────────────────────────────────────────────────

interface SeriesGroup {
  series: string;
  theme: string;
  color: string;
  events: Event[];
  medianYear: number;
  yearMin: number;
  yearMax: number;
}

interface PlaceCell {
  year: number;
  place: string;
  theme: string;
  events: Event[];
}

// ─── Topic view data ──────────────────────────────────────────────────────────

function prepareTopicView(events: Event[]): {
  groups: SeriesGroup[];
  yearMin: number;
  yearMax: number;
} {
  const seriesMap = new Map<string, Event[]>();
  for (const e of events) {
    const key = seriesOf(e.title);
    const arr = seriesMap.get(key) ?? [];
    arr.push(e);
    seriesMap.set(key, arr);
  }

  let gMin = Infinity, gMax = -Infinity;
  const groups: SeriesGroup[] = [];

  for (const [series, evs] of Array.from(seriesMap)) {
    const years = evs
      .map((e) => yearOf(e.date))
      .filter((y): y is number => y !== null)
      .sort((a, b) => a - b);
    if (years.length === 0) continue;

    const medianYear = years[Math.floor(years.length / 2)];
    gMin = Math.min(gMin, years[0]);
    gMax = Math.max(gMax, years[years.length - 1]);

    const theme = themeOf(series);
    groups.push({
      series,
      theme,
      color: colorOfTheme(theme),
      events: evs,
      medianYear,
      yearMin: years[0],
      yearMax: years[years.length - 1],
    });
  }

  return {
    groups,
    yearMin: isFinite(gMin) ? gMin : 1962,
    yearMax: isFinite(gMax) ? gMax : 1990,
  };
}

// ─── Place view data ──────────────────────────────────────────────────────────

function preparePlaceView(events: Event[]): {
  cells: PlaceCell[];
  places: string[];
  yearMin: number;
  yearMax: number;
} {
  const placeCounts = new Map<string, number>();
  const enriched = events
    .map((e) => ({
      ...e,
      _year: yearOf(e.date),
      _place: cityOf(e.location),
      _theme: themeOf(e.title),
    }))
    .filter(
      (e): e is typeof e & { _year: number; _place: string } =>
        e._year !== null && e._place !== null,
    );

  for (const e of enriched)
    placeCounts.set(e._place, (placeCounts.get(e._place) ?? 0) + 1);

  const places = Array.from(placeCounts.entries())
    .filter(([, c]) => c >= 3)
    .sort((a, b) => b[1] - a[1])
    .map(([p]) => p);

  const yearMin = enriched.reduce((m, e) => Math.min(m, e._year), Infinity);
  const yearMax = enriched.reduce((m, e) => Math.max(m, e._year), -Infinity);

  const placeSet = new Set(places);
  const bucket = new Map<string, PlaceCell>();
  for (const e of enriched) {
    if (!placeSet.has(e._place)) continue;
    const key = `${e._year}|${e._place}|${e._theme}`;
    const existing = bucket.get(key);
    if (existing) existing.events.push(e);
    else
      bucket.set(key, {
        year: e._year,
        place: e._place,
        theme: e._theme,
        events: [e],
      });
  }

  return {
    cells: Array.from(bucket.values()),
    places,
    yearMin: isFinite(yearMin) ? yearMin : 1962,
    yearMax: isFinite(yearMax) ? yearMax : 1990,
  };
}

// ─── Topic bubble layout ──────────────────────────────────────────────────────

interface BubblePos {
  cx: number;
  cy: number;
  r: number;
}

function buildTopicLayout(
  groups: SeriesGroup[],
  xFor: (y: number) => number,
  rowH: number,
  topGutter: number,
): Map<string, BubblePos> {
  const layout = new Map<string, BubblePos>();
  const themeIdx = new Map(THEMES.map((t, i) => [t.name, i]));

  // Bucket by (themeIndex, 2-year slot) to avoid overlap
  const slots = new Map<string, SeriesGroup[]>();
  for (const g of groups) {
    const ti = themeIdx.get(g.theme);
    if (ti === undefined) continue;
    const slot = Math.round(g.medianYear / 2) * 2;
    const key = `${ti}|${slot}`;
    const arr = slots.get(key) ?? [];
    arr.push(g);
    slots.set(key, arr);
  }

  for (const [key, gs] of Array.from(slots)) {
    const [tiStr, slotStr] = key.split('|');
    const ti = parseInt(tiStr, 10);
    const slot = parseInt(slotStr, 10);
    const yBase = topGutter + (ti + 0.5) * rowH;
    const cx = xFor(slot);
    const n = gs.length;
    const spread = rowH * 0.62;

    gs.forEach((g, i) => {
      const yOff = n === 1 ? 0 : ((i / (n - 1)) - 0.5) * spread;
      const r = Math.min(16, 3.5 + Math.sqrt(g.events.length) * 1.2);
      layout.set(g.series, { cx, cy: yBase + yOff, r });
    });
  }

  return layout;
}

// ─── Component ────────────────────────────────────────────────────────────────

export default function Constellation() {
  const { t } = useLocale();
  const [events, setEvents] = useState<Event[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<'topic' | 'place'>('topic');
  const [hiddenThemes, setHiddenThemes] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<SelectedItem | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/catalog')
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error((body && body.error) || `Status ${res.status}`);
        return body as CatalogResponse;
      })
      .then((body) => !cancelled && setEvents(body.events ?? []))
      .catch((err: Error) => !cancelled && setError(err.message || 'Archive unreachable.'))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  const topicData = useMemo(
    () => (events ? prepareTopicView(events) : null),
    [events],
  );
  const placeData = useMemo(
    () => (events ? preparePlaceView(events) : null),
    [events],
  );

  // Theme counts for badge on toggles
  const themeCounts = useMemo(() => {
    const counts = new Map<string, number>();
    if (view === 'topic' && topicData) {
      for (const g of topicData.groups) {
        counts.set(g.theme, (counts.get(g.theme) ?? 0) + 1);
      }
    } else if (view === 'place' && placeData) {
      for (const c of placeData.cells) {
        counts.set(c.theme, (counts.get(c.theme) ?? 0) + c.events.length);
      }
    }
    return counts;
  }, [view, topicData, placeData]);

  const toggleTheme = (name: string) =>
    setHiddenThemes((prev) => {
      const n = new Set(prev);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });

  if (loading || (!topicData && !error)) {
    return (
      <main className="min-h-screen bg-[rgb(var(--bg))] text-[rgb(var(--fg))] pt-32 px-8">
        {error ? (
          <div className="max-w-md border border-gold/20 rounded-sm p-6">
            <div className="text-[10px] tracking-[0.4em] uppercase text-gold mb-2">
              {t('constellation.error')}
            </div>
            <div className="text-sm text-stone-600 dark:text-ivory/85">{error}</div>
          </div>
        ) : (
          <div className="animate-pulse text-[10px] tracking-[0.5em] uppercase text-gold/80">
            {t('constellation.loading')}
          </div>
        )}
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[rgb(var(--bg))] text-[rgb(var(--fg))] selection:bg-gold/30">
      <div className="max-w-6xl mx-auto pt-28 md:pt-32 pb-20 px-6 md:px-8">

        {/* Header */}
        <div className="flex flex-wrap items-end justify-between gap-4 mb-8">
          <div>
            <h1 className="text-2xl md:text-3xl font-light mb-1 tracking-wide text-[rgb(var(--fg))]">
              {t('constellation.title')}
            </h1>
            <p className="text-sm text-stone-500 dark:text-ivory/65 max-w-xl">
              {view === 'topic'
                ? 'Each bubble is a discourse series, sized by talk count, positioned by year.'
                : 'Each bubble is a group of talks sharing a theme at a location and year.'}
            </p>
          </div>

          {/* View toggle */}
          <div className="flex items-center gap-1 text-[11px] tracking-[0.2em] uppercase border border-gold/20 rounded-sm overflow-hidden">
            {(['topic', 'place'] as const).map((v) => (
              <button
                key={v}
                onClick={() => { setView(v); setSelected(null); }}
                className={`px-4 py-2 transition-colors ${
                  view === v
                    ? 'bg-gold/15 text-gold'
                    : 'text-stone-500 dark:text-ivory/55 hover:text-stone-900 dark:hover:text-ivory'
                }`}
              >
                By {v === 'topic' ? 'Topic' : 'Place'}
              </button>
            ))}
          </div>
        </div>

        {/* Theme toggles */}
        <div className="flex flex-wrap gap-2 mb-8">
          {THEMES.map((th) => {
            const active = !hiddenThemes.has(th.name);
            const count = themeCounts.get(th.name) ?? 0;
            if (count === 0) return null;
            return (
              <button
                key={th.name}
                onClick={() => toggleTheme(th.name)}
                aria-pressed={active}
                className={`flex items-center gap-2 px-3 py-1.5 text-[10px] tracking-[0.18em] uppercase rounded-sm border transition-all ${
                  active
                    ? 'border-stone-400 dark:border-ivory/30 text-stone-700 dark:text-ivory'
                    : 'border-stone-200 dark:border-ivory/10 text-stone-400 dark:text-ivory/35'
                }`}
              >
                <span
                  className="inline-block w-2 h-2 rounded-full shrink-0"
                  style={{
                    background: active ? th.color : 'transparent',
                    border: `1px solid ${th.color}`,
                  }}
                />
                {th.name}
                <span className="opacity-50">
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Visualization */}
        <div className="overflow-x-auto border border-gold/15 dark:border-gold/10 rounded-sm bg-stone-50 dark:bg-white/[0.02]">
          {view === 'topic' && topicData ? (
            <TopicSvg
              data={topicData}
              hiddenThemes={hiddenThemes}
              onSelect={setSelected}
            />
          ) : placeData ? (
            <PlaceSvg
              data={placeData}
              hiddenThemes={hiddenThemes}
              onSelect={setSelected}
            />
          ) : null}
        </div>

        <div className="mt-3 text-[10px] tracking-[0.2em] uppercase text-stone-400 dark:text-ivory/50">
          {view === 'topic'
            ? 'Click any bubble to see the discourse series'
            : t('constellation.legend')}
        </div>
      </div>

      {/* Side panel */}
      {selected && (
        <aside className="fixed inset-y-0 right-0 w-full md:w-[420px] bg-[rgb(var(--bg))]/97 border-l border-gold/20 backdrop-blur-md z-40 overflow-y-auto">
          <div className="p-6">
            <div className="flex items-start justify-between mb-6">
              <div>
                <div
                  className="text-[10px] tracking-[0.35em] uppercase mb-2 font-medium"
                  style={{ color: selected.color }}
                >
                  {selected.heading}
                </div>
                <div className="text-xs text-stone-500 dark:text-ivory/65">
                  {selected.subheading}
                </div>
              </div>
              <button
                onClick={() => setSelected(null)}
                aria-label={t('constellation.close')}
                className="shrink-0 text-stone-400 dark:text-ivory/55 hover:text-stone-900 dark:hover:text-ivory transition-colors"
              >
                <X size={18} />
              </button>
            </div>

            <ul className="space-y-3">
              {selected.events.map((e) => (
                <li key={e.id}>
                  <Link
                    href={`/read?event_id=${encodeURIComponent(e.id)}`}
                    className="block group no-underline"
                  >
                    <div className="text-sm text-[rgb(var(--fg))] group-hover:text-gold transition-colors leading-snug">
                      {e.title}
                    </div>
                    {e.date && (
                      <div className="text-[10px] tracking-[0.2em] uppercase text-stone-400 dark:text-ivory/50 mt-0.5">
                        {e.date}
                      </div>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </aside>
      )}
    </main>
  );
}

// ─── Topic SVG ────────────────────────────────────────────────────────────────

function TopicSvg({
  data,
  hiddenThemes,
  onSelect,
}: {
  data: ReturnType<typeof prepareTopicView>;
  hiddenThemes: Set<string>;
  onSelect: (item: SelectedItem) => void;
}) {
  const { groups, yearMin, yearMax } = data;

  const leftGutter = 195;
  const topGutter = 55;
  const rowH = 78;
  const width = 1120;
  const plotWidth = width - leftGutter - 20;
  const height = topGutter + THEMES.length * rowH + 40;
  const yearSpan = Math.max(1, yearMax - yearMin);

  const xFor = (year: number) =>
    leftGutter + ((year - yearMin) / yearSpan) * plotWidth;

  const layout = useMemo(
    () => buildTopicLayout(groups, xFor, rowH, topGutter),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [groups, yearMin, yearMax],
  );

  const decadeTicks: number[] = [];
  for (let y = Math.ceil(yearMin / 5) * 5; y <= yearMax; y += 5)
    decadeTicks.push(y);

  const visible = groups.filter((g) => !hiddenThemes.has(g.theme));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ minWidth: 760 }}>
      {/* Row bands */}
      {THEMES.map((th, i) => (
        <rect
          key={th.name}
          x={0}
          y={topGutter + i * rowH}
          width={width}
          height={rowH}
          fill={i % 2 === 0 ? 'rgba(0,0,0,0.01)' : 'transparent'}
        />
      ))}

      {/* Row labels */}
      {THEMES.map((th, i) => (
        <text
          key={th.name}
          x={leftGutter - 12}
          y={topGutter + (i + 0.5) * rowH}
          fontSize="10"
          textAnchor="end"
          dominantBaseline="central"
          style={{ fill: th.color, opacity: hiddenThemes.has(th.name) ? 0.25 : 0.9 }}
        >
          {th.name}
        </text>
      ))}

      {/* Row dividers */}
      {THEMES.map((_, i) => (
        <line
          key={i}
          x1={leftGutter}
          x2={width - 20}
          y1={topGutter + (i + 1) * rowH}
          y2={topGutter + (i + 1) * rowH}
          stroke="rgba(212,175,55,0.07)"
        />
      ))}

      {/* Year ticks */}
      {decadeTicks.map((y) => (
        <g key={y}>
          <line
            x1={xFor(y)}
            x2={xFor(y)}
            y1={topGutter}
            y2={topGutter + THEMES.length * rowH}
            stroke="rgba(212,175,55,0.06)"
          />
          <text
            x={xFor(y)}
            y={topGutter - 14}
            fontSize="10"
            textAnchor="middle"
            style={{ fill: 'rgba(var(--fg), 0.55)' }}
          >
            {y}
          </text>
        </g>
      ))}

      {/* Bubbles */}
      {visible.map((g) => {
        const pos = layout.get(g.series);
        if (!pos) return null;
        return (
          <circle
            key={g.series}
            cx={pos.cx}
            cy={pos.cy}
            r={pos.r}
            fill={g.color}
            fillOpacity={0.78}
            stroke="rgba(0,0,0,0.25)"
            strokeWidth={0.5}
            className="cursor-pointer hover:stroke-white hover:stroke-2 hover:fill-opacity-100"
            onClick={() =>
              onSelect({
                heading: `${g.theme}  ·  ${g.series}`,
                subheading:
                  g.yearMin === g.yearMax
                    ? `${g.events.length} talk${g.events.length !== 1 ? 's' : ''}  ·  ${g.yearMin}`
                    : `${g.events.length} talk${g.events.length !== 1 ? 's' : ''}  ·  ${g.yearMin}–${g.yearMax}`,
                color: g.color,
                events: g.events,
              })
            }
          >
            <title>
              {g.series} · {g.events.length} talk{g.events.length !== 1 ? 's' : ''}
              {g.yearMin !== g.yearMax
                ? ` · ${g.yearMin}–${g.yearMax}`
                : ` · ${g.yearMin}`}
            </title>
          </circle>
        );
      })}
    </svg>
  );
}

// ─── Place SVG ────────────────────────────────────────────────────────────────

function PlaceSvg({
  data,
  hiddenThemes,
  onSelect,
}: {
  data: ReturnType<typeof preparePlaceView>;
  hiddenThemes: Set<string>;
  onSelect: (item: SelectedItem) => void;
}) {
  const { cells, places, yearMin, yearMax } = data;

  const leftGutter = 140;
  const topGutter = 55;
  const rowH = 34;
  const width = 1120;
  const plotWidth = width - leftGutter - 20;
  const yearSpan = Math.max(1, yearMax - yearMin);
  const height = topGutter + places.length * rowH + 40;

  const xFor = (year: number) =>
    leftGutter + ((year - yearMin) / yearSpan) * plotWidth;
  const yFor = (place: string) =>
    topGutter + (places.indexOf(place) + 0.5) * rowH;
  const MAX_R = rowH / 2 - 3;
  const rFor = (n: number) => Math.min(MAX_R, 2.5 + Math.sqrt(n) * 1.1);

  const jitter = (cell: PlaceCell) => {
    const ti = THEMES.findIndex((t) => t.name === cell.theme);
    const angle = (ti * 137.5 * Math.PI) / 180;
    return { dx: Math.cos(angle) * 3.5, dy: Math.sin(angle) * 3.5 };
  };

  const decadeTicks: number[] = [];
  for (let y = Math.ceil(yearMin / 5) * 5; y <= yearMax; y += 5)
    decadeTicks.push(y);

  const visible = cells.filter((c) => !hiddenThemes.has(c.theme));

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ minWidth: 720 }}>
      {/* Row guides */}
      {places.map((p, i) => (
        <g key={p}>
          <line
            x1={leftGutter}
            x2={width - 20}
            y1={topGutter + (i + 1) * rowH}
            y2={topGutter + (i + 1) * rowH}
            stroke="rgba(212,175,55,0.07)"
          />
          <text
            x={leftGutter - 10}
            y={yFor(p)}
            fontSize="10"
            textAnchor="end"
            dominantBaseline="central"
            style={{ fill: 'rgba(var(--fg), 0.72)' }}
          >
            {p}
          </text>
        </g>
      ))}

      {/* Year ticks */}
      {decadeTicks.map((y) => (
        <g key={y}>
          <line
            x1={xFor(y)}
            x2={xFor(y)}
            y1={topGutter}
            y2={topGutter + places.length * rowH}
            stroke="rgba(212,175,55,0.07)"
          />
          <text
            x={xFor(y)}
            y={topGutter - 14}
            fontSize="10"
            textAnchor="middle"
            style={{ fill: 'rgba(var(--fg), 0.55)' }}
          >
            {y}
          </text>
        </g>
      ))}

      {/* Bubbles */}
      {visible.map((cell) => {
        const { dx, dy } = jitter(cell);
        const color = colorOfTheme(cell.theme);
        return (
          <circle
            key={`${cell.year}-${cell.place}-${cell.theme}`}
            cx={xFor(cell.year) + dx}
            cy={yFor(cell.place) + dy}
            r={rFor(cell.events.length)}
            fill={color}
            fillOpacity={0.82}
            stroke="rgba(0,0,0,0.25)"
            strokeWidth={0.5}
            className="cursor-pointer hover:stroke-white hover:stroke-2 hover:fill-opacity-100"
            onClick={() =>
              onSelect({
                heading: `${cell.theme}  ·  ${cell.place}  ·  ${cell.year}`,
                subheading: `${cell.events.length} talk${cell.events.length !== 1 ? 's' : ''}`,
                color,
                events: cell.events,
              })
            }
          >
            <title>
              {cell.theme} · {cell.place} · {cell.year} · {cell.events.length} talk
              {cell.events.length !== 1 ? 's' : ''}
            </title>
          </circle>
        );
      })}
    </svg>
  );
}
