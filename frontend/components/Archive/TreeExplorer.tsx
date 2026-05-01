'use client';

import React, { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import { BookOpen, ChevronRight, ChevronDown } from 'lucide-react';

// ─── Types ────────────────────────────────────────────────────────────────────

interface Event {
  id: string;
  title: string | null;
  date: string | null;
  location: string | null;
  language?: string | null;
  tags?: string[];
}

type GroupDim = 'year' | 'place' | 'theme';

// ─── Theme classification (mirrors Constellation) ─────────────────────────────

const THEMES: { name: string; color: string; keys: string[] }[] = [
  { name: 'Zen & Buddhism',    color: '#10b981', keys: ['zen','dhammapada','bodhidharma','hui neng','huang po','hsin hsin','no water no moon','white lotus','dang dang','this very body','grass grows','sandokai','ah this','take it easy','atisha','nagarjuna','book of wisdom','returning to the source','communism and zen','the buddha said','nirvana','ma tzu','the further shore','rinzai','prajna','flash of lightning','one seed makes','the miracle','walking in zen','nansen','language of existence','flowers showered','om mani','diamond sutra','heart sutra','zen fire'] },
  { name: 'Vedanta & Upanishads', color: '#f97316', keys: ['vedanta','upanishad','shankara','ashtavakra','yoga vasistha','mahageeta','sarvasar','brihadaranyaka','supreme doctrine','isha upanishad','bhagavad','geeta','gita','krishna','that art thou','ultimate alchemy','philosophia ultima','mandukya','vivekachudamani'] },
  { name: 'Tantra & Shaivism', color: '#ef4444', keys: ['tantra','vigyan','bhairav','shiva sutra','book of secrets','shakti','tantric','tilopa','mahamudra'] },
  { name: 'Yoga',              color: '#84cc16', keys: ['yoga:','yoga ','patanjali','kundalini','pranayama','in search of the miraculous'] },
  { name: 'Taoism',            color: '#06b6d4', keys: ['tao:','tao ','taoism','chuang tzu','lao tzu','lieh tzu','empty boat','when the shoe fits','secret of secrets','golden gate'] },
  { name: 'Sufism',            color: '#8b5cf6', keys: ['sufi','rumi','farid','sanai','khayyam','mansoor','unio mystica','perfect master','until you die','just like that','come come yet again'] },
  { name: 'Christianity',      color: '#a78bfa', keys: ['jesus','christ','christian','gospel','mustard seed','come follow me','i say unto','thomas','theologia mystica'] },
  { name: 'Bhakti & Saints',   color: '#f43f5e', keys: ['kabir','meera','mira','nanak','tukaram','mirabai','divine melody','path of love','ecstasy: the forgotten','immortal friend','nowhere to go','sahajo'] },
  { name: 'Jainism',           color: '#fb923c', keys: ['mahavira','jain','mrityu','jeevan','sambodhi','anand ki','main mrityu','mahaveer'] },
  { name: 'Philosophy',        color: '#3b82f6', keys: ['philosoph','nietzsche','heraclitus','socrates','gurdjieff','pythagoras','zarathustra','occult','esoteric','the hidden harmony','the true sage','hasid'] },
  { name: 'Love & Society',    color: '#ec4899', keys: ['love','intimacy','relationship','sex','freedom','courage','creativity','intelligence','maturity'] },
  { name: 'Meditation',        color: '#f59e0b', keys: ['meditation','dhyan','silence','awareness','no-mind','witness','samadhi','emptiness','consciousness','enlighten','art of dying','transmission of the lamp','from darkness','from unconsciousness','the razor','hidden splendor','light on the path','beyond psychology','new alchemy','transformation','from death','the osho upanishad','beyond enlightenment','the new dawn','the invitation','om shantih','hari om','sat chit','the rebellious spirit','the discipline of transcendence'] },
  { name: 'Daily Discourses',  color: '#94a3b8', keys: [] },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────

function yearOf(date: string | null): string {
  const y = (date ?? '').slice(0, 4);
  return /^\d{4}$/.test(y) ? y : 'Undated';
}

// Show only year when day/month are the inferred placeholder (01-01)
function displayDate(date: string | null): string {
  if (!date) return '';
  if (date.length >= 10 && date.slice(5, 10) === '01-01') return date.slice(0, 4);
  return date.slice(0, 10);
}

function cityOf(loc: string | null | undefined): string {
  if (!loc) return 'Unknown';
  const l = loc.toLowerCase();
  if (l.includes('rajneeshpuram') || l.includes('oregon')) return 'Oregon';
  if (l.includes('pune') || l.includes('poona')) return 'Pune';
  if (l.includes('bombay') || l.includes('mumbai')) return 'Bombay';
  if (l.includes('kathmandu')) return 'Kathmandu';
  if (l.includes('jabalpur')) return 'Jabalpur';
  if (l.includes('mt. abu') || l.includes('mount abu') || l.includes('mt abu')) return 'Mt. Abu';
  if (l.includes('gadarwara')) return 'Gadarwara';
  if (l.includes('uruguay') || l.includes('montevideo')) return 'Uruguay';
  if (l.includes('crete')) return 'Crete';
  if (l.includes('greece')) return 'Greece';
  if (l.includes('portugal')) return 'Portugal';
  if (l.includes('world tour')) return 'World Tour';
  if (l.includes('india')) return 'India';
  const first = loc.split(',')[0].trim();
  return first.length < 25 ? first : 'Other';
}

function themeOf(title: string | null): string {
  if (!title) return 'Daily Discourses';
  const s = (title.includes(' ~ ') ? title.split(' ~ ')[0] : title).toLowerCase();
  for (const t of THEMES) {
    if (t.keys.length > 0 && t.keys.some((k) => s.includes(k))) return t.name;
  }
  return 'Daily Discourses';
}

function seriesOf(title: string | null): string {
  if (!title) return 'Untitled';
  return title.includes(' ~ ') ? title.split(' ~ ')[0].trim() : title.trim();
}

function themeColor(name: string): string {
  return THEMES.find((t) => t.name === name)?.color ?? '#94a3b8';
}

// ─── Derived structures ───────────────────────────────────────────────────────

interface EnrichedEvent extends Event {
  _year: string;
  _city: string;
  _theme: string;
  _series: string;
  _lang: string;
}

function enrich(events: Event[]): EnrichedEvent[] {
  return events.map((e) => ({
    ...e,
    _year:   yearOf(e.date),
    _city:   cityOf(e.location),
    _theme:  themeOf(e.title),
    _series: seriesOf(e.title),
    _lang:   e.language ?? '',
  }));
}

// Count occurrences of each key, return sorted by count desc
function countBy<T>(items: T[], key: (t: T) => string): { label: string; count: number }[] {
  const c: Record<string, number> = {};
  for (const item of items) { const k = key(item); c[k] = (c[k] ?? 0) + 1; }
  return Object.entries(c)
    .map(([label, count]) => ({ label, count }))
    .sort((a, b) => b.count - a.count);
}

// ─── Sub-components ───────────────────────────────────────────────────────────

function BarRow({
  label, count, maxCount, color, onClick,
}: {
  label: string; count: number; maxCount: number; color?: string; onClick: () => void;
}) {
  const pct = maxCount > 0 ? (count / maxCount) * 100 : 0;
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full text-left flex items-center gap-4 py-2 px-3 rounded hover:bg-gold/5 group transition-colors"
    >
      <span className="w-32 flex-shrink-0 text-[13px] font-medium text-[rgb(var(--fg))] truncate group-hover:text-gold transition-colors">
        {label}
      </span>
      <div className="flex-1 h-1.5 bg-stone-100 dark:bg-ivory/5 rounded-full overflow-hidden">
        <div
          className="h-full rounded-full transition-all"
          style={{ width: `${pct}%`, backgroundColor: color ?? '#d4af37' }}
        />
      </div>
      <span className="w-16 text-right text-[12px] text-stone-400 dark:text-ivory/40 flex-shrink-0 tabular-nums">
        {count.toLocaleString()}
      </span>
      <ChevronRight size={14} className="text-gold/40 group-hover:text-gold transition-colors flex-shrink-0" />
    </button>
  );
}

function Chip({
  label, active, color, onClick,
}: {
  label: string; active: boolean; color?: string; onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={active ? { backgroundColor: color ?? '#d4af37', borderColor: color ?? '#d4af37', color: '#000' } : {}}
      className={`px-2.5 py-1 rounded-full text-[11px] border transition-all ${
        active ? '' : 'border-gold/20 text-stone-500 dark:text-ivory/50 hover:border-gold/50'
      }`}
    >
      {label}
    </button>
  );
}

function SeriesList({ events }: { events: EnrichedEvent[] }) {
  const [openSeries, setOpenSeries] = useState<string | null>(null);

  const grouped = useMemo(() => {
    const map = new Map<string, EnrichedEvent[]>();
    for (const e of events) {
      if (!map.has(e._series)) map.set(e._series, []);
      map.get(e._series)!.push(e);
    }
    // Sort each series by date
    for (const [, talks] of Array.from(map)) talks.sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));
    // Sort series by first talk date
    return Array.from(map.entries()).sort((a, b) => (a[1][0].date ?? '').localeCompare(b[1][0].date ?? ''));
  }, [events]);

  if (!grouped.length) return (
    <div className="text-center py-8 text-stone-400 dark:text-ivory/40 text-sm">No talks match these filters.</div>
  );

  return (
    <div className="space-y-1">
      {grouped.map(([name, talks]) => {
        const open = openSeries === name;
        const theme = talks[0]._theme;
        const color = themeColor(theme);
        return (
          <div key={name} className="border border-gold/10 rounded-sm overflow-hidden"
            style={{ borderLeftColor: color, borderLeftWidth: 2 }}>
            <button
              type="button"
              onClick={() => setOpenSeries(open ? null : name)}
              className="w-full text-left px-4 py-2.5 flex items-center justify-between gap-3 hover:bg-gold/5 transition-colors"
            >
              <div className="flex-1 min-w-0">
                <span className="text-[13px] font-medium text-[rgb(var(--fg))] truncate block">{name}</span>
                <span className="text-[11px] text-stone-400 dark:text-ivory/40">
                  {talks.length} {talks.length === 1 ? 'talk' : 'talks'}
                  {talks[0]._city !== 'Unknown' && ` · ${talks[0]._city}`}
                  {talks[0]._lang && talks[0]._lang !== 'English' && ` · ${talks[0]._lang}`}
                </span>
              </div>
              <span className="text-[10px] tracking-[0.1em] uppercase px-1.5 py-0.5 rounded flex-shrink-0"
                style={{ color, backgroundColor: color + '18' }}>
                {theme}
              </span>
              {open ? <ChevronDown size={13} className="text-gold/50 flex-shrink-0" /> : <ChevronRight size={13} className="text-gold/30 flex-shrink-0" />}
            </button>
            {open && (
              <div className="border-t border-gold/10 px-4 py-2 space-y-1 max-h-60 overflow-y-auto"
                style={{ backgroundColor: color + '08' }}>
                {talks.map((ev) => (
                  <div key={ev.id} className="flex items-center justify-between gap-3">
                    <Link
                      href={`/read?event_id=${encodeURIComponent(ev.id)}`}
                      className="text-[12px] text-stone-600 dark:text-ivory/75 hover:text-gold truncate flex-1"
                    >
                      {ev.title ?? 'Untitled'}
                    </Link>
                    <span className="text-[11px] text-stone-400 dark:text-ivory/35 flex-shrink-0 tabular-nums">
                      {displayDate(ev.date)}
                    </span>
                    <Link href={`/read?event_id=${encodeURIComponent(ev.id)}`}
                      className="flex-shrink-0">
                      <BookOpen size={11} className="text-gold/40 hover:text-gold" />
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function TreeExplorer() {
  const [rawEvents, setRawEvents]   = useState<Event[]>([]);
  const [loading,   setLoading]     = useState(true);
  const [error,     setError]       = useState<string | null>(null);

  // Navigation state
  const [groupDim,  setGroupDim]    = useState<GroupDim>('theme');
  const [selected,  setSelected]    = useState<string | null>(null);

  // Secondary filters (applied once a group is selected)
  const [filterCity,  setFilterCity]  = useState('');
  const [filterYear,  setFilterYear]  = useState('');
  const [filterTheme, setFilterTheme] = useState('');
  const [filterLang,  setFilterLang]  = useState('');

  useEffect(() => {
    fetch('/api/catalog', { cache: 'no-store' })
      .then((r) => r.json())
      .then((d: { events: Event[] }) => { setRawEvents(d.events ?? []); setLoading(false); })
      .catch(() => { setError('Archive unreachable.'); setLoading(false); });
  }, []);

  const events = useMemo(() => enrich(rawEvents), [rawEvents]);

  // Reset secondary filters when navigation changes
  function selectGroup(dim: GroupDim, val: string) {
    setGroupDim(dim); setSelected(val);
    setFilterCity(''); setFilterYear(''); setFilterTheme(''); setFilterLang('');
  }

  function changeDim(dim: GroupDim) {
    setGroupDim(dim); setSelected(null);
    setFilterCity(''); setFilterYear(''); setFilterTheme(''); setFilterLang('');
  }

  // Level-1 groups
  const topGroups = useMemo(() => {
    if (groupDim === 'year') {
      return countBy(events, (e) => e._year)
        .sort((a, b) => {
          const na = /^\d+$/.test(a.label) ? parseInt(a.label) : -1;
          const nb = /^\d+$/.test(b.label) ? parseInt(b.label) : -1;
          return nb - na;   // newest first
        });
    }
    if (groupDim === 'place') {
      return countBy(events, (e) => e._city)
        .filter((g) => g.label !== 'Unknown')
        .concat(countBy(events, (e) => e._city).filter((g) => g.label === 'Unknown'));
    }
    // theme — maintain THEMES order
    const c: Record<string, number> = {};
    for (const e of events) c[e._theme] = (c[e._theme] ?? 0) + 1;
    return THEMES.filter((t) => c[t.name]).map((t) => ({ label: t.name, count: c[t.name] ?? 0 }));
  }, [events, groupDim]);

  const maxCount = useMemo(() => Math.max(...topGroups.map((g) => g.count), 1), [topGroups]);

  // Filtered events for the detail view
  const filteredEvents = useMemo(() => {
    if (!selected) return [];
    let ev = events;
    if (groupDim === 'year')  ev = ev.filter((e) => e._year  === selected);
    if (groupDim === 'place') ev = ev.filter((e) => e._city  === selected);
    if (groupDim === 'theme') ev = ev.filter((e) => e._theme === selected);
    if (filterCity)  ev = ev.filter((e) => e._city  === filterCity);
    if (filterYear)  ev = ev.filter((e) => e._year  === filterYear);
    if (filterTheme) ev = ev.filter((e) => e._theme === filterTheme);
    if (filterLang)  ev = ev.filter((e) => e._lang  === filterLang);
    return ev;
  }, [events, selected, groupDim, filterCity, filterYear, filterTheme, filterLang]);

  // Secondary filter options based on the selected group
  const secondaryFilters = useMemo(() => {
    if (!selected) return { cities: [], years: [], themes: [], langs: [] };
    let base = events;
    if (groupDim === 'year')  base = base.filter((e) => e._year  === selected);
    if (groupDim === 'place') base = base.filter((e) => e._city  === selected);
    if (groupDim === 'theme') base = base.filter((e) => e._theme === selected);
    return {
      cities: groupDim !== 'place' ? countBy(base, (e) => e._city).filter((c) => c.label !== 'Unknown') : [],
      years:  groupDim !== 'year'  ? countBy(base, (e) => e._year).sort((a, b) => parseInt(a.label) - parseInt(b.label)) : [],
      themes: groupDim !== 'theme' ? THEMES.filter((t) => base.some((e) => e._theme === t.name))
                                           .map((t) => ({ label: t.name, count: base.filter((e) => e._theme === t.name).length })) : [],
      langs: countBy(base, (e) => e._lang).filter((l) => l.label),
    };
  }, [events, selected, groupDim]);

  if (loading) return (
    <main className="max-w-4xl mx-auto px-4 py-12 text-center text-stone-400 dark:text-ivory/40 text-sm">
      Loading archive…
    </main>
  );
  if (error) return (
    <main className="max-w-4xl mx-auto px-4 py-12 text-center text-red-500 text-sm">{error}</main>
  );

  return (
    <main className="max-w-4xl mx-auto px-4 pt-28 pb-20">
      {/* Header */}
      <div className="mb-8">
        <h1 className="text-2xl font-light text-[rgb(var(--fg))] tracking-wide mb-1">Archive</h1>
        <p className="text-[13px] text-stone-500 dark:text-ivory/55">
          {rawEvents.length.toLocaleString()} talks across {topGroups.length}{' '}
          {groupDim === 'year' ? 'years' : groupDim === 'place' ? 'locations' : 'themes'}
        </p>
      </div>

      {/* Dimension tabs */}
      <div className="flex gap-1 mb-6 border-b border-gold/15 pb-3">
        {(['theme', 'year', 'place'] as GroupDim[]).map((dim) => (
          <button
            key={dim}
            onClick={() => changeDim(dim)}
            className={`px-4 py-1.5 text-[11px] tracking-[0.2em] uppercase rounded transition-colors ${
              groupDim === dim
                ? 'bg-gold/15 text-gold border border-gold/30'
                : 'text-stone-400 dark:text-ivory/45 hover:text-gold'
            }`}
          >
            By {dim}
          </button>
        ))}
      </div>

      {/* Breadcrumb */}
      {selected && (
        <div className="flex items-center gap-2 mb-5 text-[12px]">
          <button
            onClick={() => setSelected(null)}
            className="text-gold hover:underline"
          >
            All {groupDim === 'year' ? 'Years' : groupDim === 'place' ? 'Places' : 'Themes'}
          </button>
          <ChevronRight size={12} className="text-stone-400" />
          <span className="text-[rgb(var(--fg))] font-medium">{selected}</span>
          <span className="text-stone-400 dark:text-ivory/40 ml-2">
            {filteredEvents.length.toLocaleString()} talks
          </span>
        </div>
      )}

      {/* Level 1 — group list */}
      {!selected && (
        <div className="space-y-0.5">
          {topGroups.map((g) => (
            <BarRow
              key={g.label}
              label={g.label}
              count={g.count}
              maxCount={maxCount}
              color={groupDim === 'theme' ? themeColor(g.label) : '#d4af37'}
              onClick={() => selectGroup(groupDim, g.label)}
            />
          ))}
        </div>
      )}

      {/* Level 2 — filters + talk list */}
      {selected && (
        <div className="space-y-4">
          {/* Secondary filter chips */}
          <div className="space-y-2">
            {secondaryFilters.cities.length > 1 && (
              <div className="flex flex-wrap gap-1.5 items-center">
                <span className="text-[10px] tracking-[0.2em] uppercase text-stone-400 dark:text-ivory/40 w-12">Place</span>
                <Chip label="All" active={!filterCity} onClick={() => setFilterCity('')} />
                {secondaryFilters.cities.map((c) => (
                  <Chip key={c.label} label={`${c.label} ${c.count}`} active={filterCity === c.label}
                    onClick={() => setFilterCity(filterCity === c.label ? '' : c.label)} />
                ))}
              </div>
            )}
            {secondaryFilters.years.length > 1 && (
              <div className="flex flex-wrap gap-1.5 items-center">
                <span className="text-[10px] tracking-[0.2em] uppercase text-stone-400 dark:text-ivory/40 w-12">Year</span>
                <Chip label="All" active={!filterYear} onClick={() => setFilterYear('')} />
                {secondaryFilters.years.map((y) => (
                  <Chip key={y.label} label={`${y.label} · ${y.count}`} active={filterYear === y.label}
                    onClick={() => setFilterYear(filterYear === y.label ? '' : y.label)} />
                ))}
              </div>
            )}
            {secondaryFilters.themes.length > 1 && (
              <div className="flex flex-wrap gap-1.5 items-center">
                <span className="text-[10px] tracking-[0.2em] uppercase text-stone-400 dark:text-ivory/40 w-12">Theme</span>
                <Chip label="All" active={!filterTheme} onClick={() => setFilterTheme('')} />
                {secondaryFilters.themes.map((th) => (
                  <Chip key={th.label} label={th.label} active={filterTheme === th.label}
                    color={themeColor(th.label)}
                    onClick={() => setFilterTheme(filterTheme === th.label ? '' : th.label)} />
                ))}
              </div>
            )}
            {secondaryFilters.langs.length > 1 && (
              <div className="flex flex-wrap gap-1.5 items-center">
                <span className="text-[10px] tracking-[0.2em] uppercase text-stone-400 dark:text-ivory/40 w-12">Lang</span>
                <Chip label="All" active={!filterLang} onClick={() => setFilterLang('')} />
                {secondaryFilters.langs.map((l) => (
                  <Chip key={l.label} label={l.label} active={filterLang === l.label}
                    onClick={() => setFilterLang(filterLang === l.label ? '' : l.label)} />
                ))}
              </div>
            )}
          </div>

          {/* Talk list */}
          <SeriesList events={filteredEvents} />
        </div>
      )}
    </main>
  );
}
