'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { X } from 'lucide-react';
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

const THEMES: { name: string; keys: string[]; color: string }[] = [
  { name: 'Meditation', keys: ['meditation', 'dhyan', 'silence'], color: '#f59e0b' },
  { name: 'Zen',        keys: ['zen', 'bodhidharma', 'hsin hsin ming'], color: '#10b981' },
  { name: 'Tantra',     keys: ['tantra', 'vigyan bhairav'], color: '#ef4444' },
  { name: 'Sufism',     keys: ['sufi', 'rumi'], color: '#8b5cf6' },
  { name: 'Love',       keys: ['love', 'intimacy'], color: '#ec4899' },
  { name: 'Philosophy', keys: ['philosoph', 'heraclitus', 'nietzsche'], color: '#3b82f6' },
  { name: 'Other',      keys: [], color: '#94a3b8' },
];

function themeOf(title: string): string {
  const t = (title ?? '').toLowerCase();
  for (const theme of THEMES) {
    if (theme.keys.some((k) => t.includes(k))) return theme.name;
  }
  return 'Other';
}

function colorOfTheme(name: string): string {
  return THEMES.find((t) => t.name === name)?.color ?? '#94a3b8';
}

function yearOf(date: string | null): number | null {
  const y = (date ?? '').slice(0, 4);
  return /^\d{4}$/.test(y) ? parseInt(y, 10) : null;
}

// All cities / regions where Osho gave discourses — including 1985–86 world tour
const KNOWN_CITIES: { match: RegExp; name: string }[] = [
  { match: /\brajneeshpuram\b|\boregon\b/i,          name: 'Rajneeshpuram' },
  { match: /\bpoona\b|\bpune\b/i,                    name: 'Pune' },
  { match: /\bbombay\b|\bmumbai\b/i,                 name: 'Bombay' },
  { match: /\bkathmandu\b/i,                         name: 'Kathmandu' },
  { match: /\bjabalpur\b/i,                          name: 'Jabalpur' },
  { match: /\bahmedabad\b/i,                         name: 'Ahmedabad' },
  { match: /\bmt\.?\s*abu\b|\bmount\s*abu\b/i,       name: 'Mt. Abu' },
  { match: /\bgadarwara\b/i,                         name: 'Gadarwara' },
  // World tour locations
  { match: /\buruguay\b|\bmontevideo\b/i,            name: 'Uruguay' },
  { match: /\bcrete\b|\bknossos\b/i,                 name: 'Crete' },
  { match: /\bgreece\b|\bathens\b|\bdelphi\b/i,      name: 'Greece' },
  { match: /\bportugal\b|\blisbon\b|\bsintra\b/i,    name: 'Portugal' },
  { match: /\bjamaica\b|\bkingston\b/i,              name: 'Jamaica' },
  { match: /\bnetherlands\b|\bholland\b|\bamsterdam\b/i, name: 'Netherlands' },
  { match: /\bireland\b|\bdublin\b/i,                name: 'Ireland' },
  { match: /\bengland\b|\blondon\b|\buk\b/i,         name: 'UK' },
  { match: /\bspain\b|\bmadrid\b|\bbarcelona\b/i,    name: 'Spain' },
  { match: /\bcanada\b|\btoronto\b|\bvancouver\b/i,  name: 'Canada' },
  // India
  { match: /\bnepal\b/i,                             name: 'Nepal' },
  { match: /\bmanali\b/i,                            name: 'Manali' },
  { match: /\bnargol\b/i,                            name: 'Nargol' },
  { match: /\bdelhi\b/i,                             name: 'Delhi' },
  { match: /\bdwarka\b/i,                            name: 'Dwarka' },
  { match: /\bkashmir\b/i,                           name: 'Kashmir' },
  { match: /\bnagpur\b/i,                            name: 'Nagpur' },
  { match: /\bsurat\b/i,                             name: 'Surat' },
  { match: /\bbaroda\b|\bvadodara\b/i,               name: 'Baroda' },
  { match: /\bbangalore\b|\bbengaluru\b/i,           name: 'Bangalore' },
  { match: /\bgoa\b/i,                               name: 'Goa' },
  { match: /\bpatiala\b/i,                           name: 'Patiala' },
];

function cityOf(loc: string | null): string | null {
  if (!loc) return null;
  for (const c of KNOWN_CITIES) {
    if (c.match.test(loc)) return c.name;
  }
  return null;
}

interface Cell {
  year: number;
  place: string;
  theme: string;
  events: Event[];
}

interface Prepared {
  yearMin: number;
  yearMax: number;
  places: string[];
  placeCounts: Map<string, number>;
  cells: Cell[];
}

function prepare(events: Event[]): Prepared {
  const placeCounts = new Map<string, number>();
  const enriched = events
    .map((e) => ({
      ...e,
      _year: yearOf(e.date),
      _place: cityOf(e.location),
      _theme: themeOf(e.title),
    }))
    .filter((e): e is typeof e & { _year: number; _place: string } =>
      e._year !== null && e._place !== null,
    );

  for (const e of enriched)
    placeCounts.set(e._place, (placeCounts.get(e._place) ?? 0) + 1);

  const MIN_TALKS_PER_PLACE = 3;
  const places = Array.from(placeCounts.entries())
    .filter(([, c]) => c >= MIN_TALKS_PER_PLACE)
    .sort((a, b) => b[1] - a[1])
    .map(([p]) => p);

  const yearMin = enriched.reduce((m, e) => Math.min(m, e._year), Infinity);
  const yearMax = enriched.reduce((m, e) => Math.max(m, e._year), -Infinity);

  const placeSet = new Set(places);
  const bucket = new Map<string, Cell>();
  for (const e of enriched) {
    if (!placeSet.has(e._place)) continue;
    const key = `${e._year}|${e._place}|${e._theme}`;
    const existing = bucket.get(key);
    if (existing) existing.events.push(e);
    else bucket.set(key, { year: e._year, place: e._place, theme: e._theme, events: [e] });
  }

  return { yearMin, yearMax, places, placeCounts, cells: Array.from(bucket.values()) };
}

export default function Constellation() {
  const { t } = useLocale();
  const [events, setEvents] = useState<Event[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [hiddenThemes, setHiddenThemes] = useState<Set<string>>(new Set(['Other']));
  const [selected, setSelected] = useState<Cell | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/catalog')
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error((body && body.error) || `Upstream status ${res.status}`);
        return body as CatalogResponse;
      })
      .then((body) => !cancelled && setEvents(body.events ?? []))
      .catch((err: Error) => !cancelled && setError(err.message || 'Archive unreachable.'))
      .finally(() => !cancelled && setLoading(false));
    return () => { cancelled = true; };
  }, []);

  const prepared = useMemo(() => (events ? prepare(events) : null), [events]);

  const visibleCells = useMemo(() => {
    if (!prepared) return [] as Cell[];
    return prepared.cells.filter((c) => !hiddenThemes.has(c.theme));
  }, [prepared, hiddenThemes]);

  const toggleThemeFn = (name: string) =>
    setHiddenThemes((prev) => {
      const n = new Set(prev);
      n.has(name) ? n.delete(name) : n.add(name);
      return n;
    });

  if (loading || !prepared) {
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

  const { yearMin, yearMax, places } = prepared;

  const leftGutter = 140;
  const topGutter = 60;
  const rowHeight = 34;
  const yearSpan = Math.max(1, yearMax - yearMin);
  const width = 1100;
  const plotWidth = width - leftGutter - 20;
  const plotHeight = places.length * rowHeight;
  const height = topGutter + plotHeight + 40;

  const xFor = (year: number) => leftGutter + ((year - yearMin) / yearSpan) * plotWidth;
  const yFor = (place: string) => topGutter + (places.indexOf(place) + 0.5) * rowHeight;
  const MAX_R = rowHeight / 2 - 4;
  const radiusFor = (count: number) => Math.min(MAX_R, 2.5 + Math.sqrt(count) * 1.1);

  const jitter = (cell: Cell) => {
    const ti = THEMES.findIndex((t) => t.name === cell.theme);
    const angle = (ti * 137.5 * Math.PI) / 180;
    const r = 4;
    return { dx: Math.cos(angle) * r, dy: Math.sin(angle) * r };
  };

  const decadeTicks: number[] = [];
  for (let y = Math.ceil(yearMin / 5) * 5; y <= yearMax; y += 5) decadeTicks.push(y);

  return (
    <main className="min-h-screen bg-[rgb(var(--bg))] text-[rgb(var(--fg))] selection:bg-gold/30">
      <div className="max-w-6xl mx-auto pt-28 md:pt-32 pb-20 px-6 md:px-8">
        <h1 className="text-2xl md:text-3xl font-light mb-3 tracking-wide text-[rgb(var(--fg))]">
          {t('constellation.title')}
        </h1>
        <p className="text-sm text-stone-500 dark:text-ivory/85 mb-8 max-w-2xl">
          {t('constellation.lead')}
        </p>

        {/* Theme toggles */}
        <div className="flex flex-wrap gap-2 mb-8">
          {THEMES.map((th) => {
            const active = !hiddenThemes.has(th.name);
            return (
              <button
                key={th.name}
                onClick={() => toggleThemeFn(th.name)}
                aria-pressed={active}
                className={`flex items-center gap-2 px-3 py-1.5 text-[10px] tracking-[0.2em] uppercase rounded-sm border transition-all ${
                  active
                    ? 'border-stone-400 dark:border-ivory/30 text-stone-700 dark:text-ivory'
                    : 'border-stone-200 dark:border-ivory/10 text-stone-400 dark:text-ivory/40'
                }`}
              >
                <span
                  className="inline-block w-2.5 h-2.5 rounded-full"
                  style={{
                    background: active ? th.color : 'transparent',
                    border: `1px solid ${th.color}`,
                  }}
                />
                {th.name}
              </button>
            );
          })}
        </div>

        {/* SVG grid */}
        <div className="overflow-x-auto border border-gold/15 dark:border-gold/10 rounded-sm bg-stone-50 dark:bg-white/[0.02]">
          <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ minWidth: 720 }}>
            {/* row guides */}
            {places.map((p, i) => (
              <g key={p}>
                <line
                  x1={leftGutter}
                  x2={width - 20}
                  y1={topGutter + (i + 1) * rowHeight}
                  y2={topGutter + (i + 1) * rowHeight}
                  stroke="rgba(212,175,55,0.08)"
                />
                <text
                  x={leftGutter - 12}
                  y={yFor(p)}
                  style={{ fill: 'rgba(var(--fg), 0.72)' }}
                  fontSize="10"
                  textAnchor="end"
                  dominantBaseline="central"
                >
                  {p}
                </text>
              </g>
            ))}

            {/* year ticks */}
            {decadeTicks.map((y) => (
              <g key={y}>
                <line
                  x1={xFor(y)}
                  x2={xFor(y)}
                  y1={topGutter}
                  y2={topGutter + plotHeight}
                  stroke="rgba(212,175,55,0.07)"
                />
                <text
                  x={xFor(y)}
                  y={topGutter - 12}
                  style={{ fill: 'rgba(var(--fg), 0.65)' }}
                  fontSize="10"
                  textAnchor="middle"
                >
                  {y}
                </text>
              </g>
            ))}

            {/* dots */}
            {visibleCells.map((cell) => {
              const { dx, dy } = jitter(cell);
              return (
                <circle
                  key={`${cell.year}-${cell.place}-${cell.theme}`}
                  cx={xFor(cell.year) + dx}
                  cy={yFor(cell.place) + dy}
                  r={radiusFor(cell.events.length)}
                  fill={colorOfTheme(cell.theme)}
                  fillOpacity={0.85}
                  stroke="rgba(0,0,0,0.3)"
                  strokeWidth={0.6}
                  className="cursor-pointer hover:stroke-white hover:stroke-2"
                  onClick={() => setSelected(cell)}
                >
                  <title>
                    {cell.theme} · {cell.place} · {cell.year} ·{' '}
                    {t(
                      cell.events.length === 1
                        ? 'constellation.talks.one'
                        : 'constellation.talks.many',
                      { n: cell.events.length },
                    )}
                  </title>
                </circle>
              );
            })}
          </svg>
        </div>

        <div className="mt-3 text-[10px] tracking-[0.2em] uppercase text-stone-400 dark:text-ivory/60">
          {t('constellation.legend')}
        </div>
      </div>

      {/* Side panel */}
      {selected && (
        <div className="fixed inset-y-0 right-0 w-full md:w-[420px] bg-[rgb(var(--bg))]/95 border-l border-gold/20 backdrop-blur-md z-40 overflow-y-auto">
          <div className="p-6">
            <div className="flex items-start justify-between mb-6">
              <div>
                <div className="text-[10px] tracking-[0.4em] uppercase text-gold mb-2">
                  {selected.theme} · {selected.place} · {selected.year}
                </div>
                <div className="text-xs text-stone-500 dark:text-ivory/70">
                  {t(
                    selected.events.length === 1
                      ? 'constellation.talks.one'
                      : 'constellation.talks.many',
                    { n: selected.events.length },
                  )}
                </div>
              </div>
              <button
                onClick={() => setSelected(null)}
                aria-label={t('constellation.close')}
                className="text-stone-500 dark:text-ivory/70 hover:text-stone-900 dark:hover:text-ivory transition-colors"
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
                      <div className="text-[10px] tracking-[0.2em] uppercase text-stone-400 dark:text-ivory/60 mt-1">
                        {e.date}
                      </div>
                    )}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}
    </main>
  );
}
