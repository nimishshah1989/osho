/**
 * The search engine — TypeScript counterpart of `scripts/cloud_api.py`'s
 * `search()`, `discourse()`, `catalog()`, and the two NEAR-augmentation
 * helpers. Pure logic over a `Database` interface (defined in `./types`)
 * so the same code runs against `better-sqlite3` in node tests and
 * against `sqlite-wasm` in the browser / WebView at runtime.
 *
 * Keep this in lockstep with `cloud_api.py`. The Python tests under
 * `scripts/tests/test_search.py` and the TS tests under
 * `frontend/lib/search/__tests__/` should agree on behaviour.
 */
import { normalizeDevanagari } from './devanagari';
import { hlTokenPositions, markersToGuillemets, HL_CLOSE, HL_OPEN } from './highlight';
import {
  isPhraseOnly,
  parseNear,
  parseQueryUnits,
  rewriteQuery,
} from './queryRewrite';
import type {
  Database,
  DiscourseParagraph,
  DiscourseResponse,
  SearchEvent,
  SearchHit,
  SearchOptions,
  SearchResponse,
} from './types';


// ─── Constants ───────────────────────────────────────────────────────────

const SHAILENDRA_RE = /\s*source\s*:\s*Shailendra.s\s+Hindi\s+collection\s*/i;
const META_PARA_PREFIX = 'event page in sannyas';

function stripShailendra(text: string): string {
  return text.replace(SHAILENDRA_RE, '').trim();
}

function isMetaParagraph(sequenceNumber: number, content: string): boolean {
  return (
    sequenceNumber === 0
    || content.toLowerCase().startsWith(META_PARA_PREFIX)
  );
}


// ─── search() ────────────────────────────────────────────────────────────

interface FtsRow {
  event_id: string;
  paragraph_id: number;
  sequence_number: number;
  content: string;
  hl: string;
  title: string | null;
  date: string | null;
  location: string | null;
  language: string | null;
  translated_from: string | null;
  source_short: string | null;
  role: string | null;
  rank: number;
}


export function search(db: Database, opts: SearchOptions): SearchResponse {
  const {
    q,
    limit = 200,
    sort = 'rank',
    language,
    original = false,
    exact = false,
    dateFrom,
    dateTo,
  } = opts;

  if (dateFrom && dateTo && dateFrom > dateTo) {
    throw new SearchError('date_from must be ≤ date_to', 400);
  }

  const ftsTable = exact ? 'paragraphs_fts_exact' : 'paragraphs_fts';
  const ftsQuery = rewriteQuery(q, { exact });
  if (!ftsQuery) throw new SearchError('Empty query.', 400);

  const filters: string[] = [];
  const filterParams: unknown[] = [];
  if (language && !['all', '*', ''].includes(language.toLowerCase())) {
    // Accept both full names and ISO codes — see cloud_api.py's
    // `_expand_language_aliases` for the same logic. Keeps the offline
    // engine tolerant to whatever the DB happens to hold.
    // "all" and "*" mean no restriction — skip the filter so the frontend
    // can safely send language="all" without getting zero results.
    const aliases = expandLanguageAliases(language);
    const placeholders = aliases.map(() => 'LOWER(?)').join(',');
    filters.push(`LOWER(e.language) IN (${placeholders})`);
    filterParams.push(...aliases);
  }
  if (original) {
    filters.push("(e.translated_from IS NULL OR LOWER(e.translated_from) = 'none')");
  }
  if (dateFrom || dateTo) {
    // Match scripts/cloud_api.py's year-overlap filter so the offline
    // engine and the FastAPI backend treat archivist notes like
    // "1971/1972 ?" the same way: the record covers [1971, 1972] and
    // matches any query range that overlaps with those years. SQLite
    // lexicographic comparison on the leading-4 substring is order-
    // preserving for valid years; garbage prefixes sort above all
    // 4-digit years and so fall out of every range.
    const firstYearExpr = 'SUBSTR(e.date, 1, 4)';
    const lastYearExpr =
      "(CASE WHEN INSTR(e.date, '/') > 0 "
      + "      THEN SUBSTR(e.date, INSTR(e.date, '/') + 1, 4) "
      + '      ELSE SUBSTR(e.date, 1, 4) END)';
    if (dateFrom) {
      filters.push(`${lastYearExpr} >= ?`);
      filterParams.push(dateFrom.slice(0, 4));
    }
    if (dateTo) {
      filters.push(`${firstYearExpr} <= ?`);
      filterParams.push(dateTo.slice(0, 4));
    }
  }
  const whereExtra = filters.length ? ' AND ' + filters.join(' AND ') : '';

  const nearParsed = parseNear(ftsQuery);

  // Decide whether this query gets RECORD-LEVEL treatment (OCTP
  // semantics): a record matches when its units appear anywhere in the
  // whole discourse (All-words), optionally within N tokens (Within-N).
  // This activates ONLY for NEAR and for multi-unit All-words queries —
  // single-word, phrase and explicit `title:` queries keep the existing
  // single-MATCH path. Mirrors the same decision in cloud_api.py.
  let recordUnits: string[] | null;
  let recordNearDist: number | null;
  if (nearParsed) {
    // All NEAR queries use record-level cross-paragraph proximity.
    // OCTP (Folio Views) finds words within N words across paragraph
    // boundaries — confirmed by Sugit 2026-06-12.
    recordUnits = nearParsed.words;
    recordNearDist = nearParsed.distance;
  } else {
    const parsed = parseQueryUnits(q, exact);
    recordUnits = parsed && parsed.length >= 2 ? parsed : null;
    recordNearDist = null;
  }

  if (recordUnits !== null) {
    const { events: recEvents, totalEvents, totalHits } = recordLevelSearch(
      db, recordUnits, recordNearDist, whereExtra, filterParams, ftsTable,
    );

    for (const ev of recEvents.values()) {
      const hitBonus = Math.log1p(ev.hit_count || 1);
      // Record-level events carry best_rank 0; rank by hit_count (more
      // matched paragraphs → earlier) so the order is stable.
      ev.best_rank = ev.best_rank - hitBonus;
    }
    // Tie-break on event_id so which events survive the `slice(0, limit)`
    // when many share a rank is deterministic and identical to the Python
    // engine (which sorts (rank, event_id) the same way).
    let out = [...recEvents.values()]
      .sort((a, b) => (a.best_rank - b.best_rank) || (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0))
      .slice(0, limit);
    if (sort === 'title') {
      out = out.sort((a, b) => {
        const t = (a.title ?? '').toLowerCase().localeCompare((b.title ?? '').toLowerCase());
        return t || (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0);
      });
    } else if (sort === 'date') {
      // Chronological, oldest first (Sugit #25a); undated records last.
      out = out.sort((a, b) => {
        const d = (a.date ?? '9999').localeCompare(b.date ?? '9999');
        return d || (a.event_id < b.event_id ? -1 : a.event_id > b.event_id ? 1 : 0);
      });
    }
    const tooMany = totalEvents > TOO_MANY_THRESHOLD;
    if (tooMany) {
      for (const ev of out) {
        if (ev.hits.length > 1) ev.hits = ev.hits.slice(0, 1);
        for (const h of ev.hits) delete (h as unknown as Record<string, unknown>)['content'];
      }
    }
    return {
      query: q,
      total: totalEvents,
      total_hits: totalHits,
      too_many: tooMany || undefined,
      events: out.map(toSearchEvent),
    };
  }

  // ── Phrase / single-word / title: — the existing single-MATCH path.
  // For a single quoted phrase we scope the COUNT/display to the content
  // column so a phrase that equals a discourse TITLE doesn't inflate the
  // hit count to one-per-paragraph (the title rides on every paragraph's
  // FTS row). A separate title-membership check still RETURNS such a
  // discourse with a small hit_count so series can be found by name (#3).
  const phraseOnly = isPhraseOnly(ftsQuery);
  const phraseInner = phraseOnly ? ftsQuery.trim() : null;
  const countQuery = phraseInner ? `{content} : (${phraseInner})` : ftsQuery;

  let rows: FtsRow[];
  try {
    rows = db.all<FtsRow>(
      `SELECT
         f.event_id,
         f.paragraph_id,
         f.sequence_number,
         f.content,
         highlight(${ftsTable}, 0, ?, ?) AS hl,
         f.title,
         e.date,
         e.location,
         e.language,
         e.translated_from AS translated_from,
         e.source_short AS source_short,
         p.role AS role,
         bm25(${ftsTable}) AS rank
       FROM ${ftsTable} f
       LEFT JOIN events e ON e.id = f.event_id
       LEFT JOIN paragraphs p ON p.id = f.paragraph_id
       WHERE ${ftsTable} MATCH ?
       ${whereExtra}
       ORDER BY rank
       LIMIT ?`,
      [HL_OPEN, HL_CLOSE, countQuery, ...filterParams, limit * 10],
    );
  } catch (e) {
    throw new SearchError('Invalid search syntax.', 400);
  }

  const events = new Map<string, MutableEvent>();
  for (const r of rows) {
    let ev = events.get(r.event_id);
    if (!ev) {
      ev = {
        event_id: r.event_id,
        title: r.title,
        date: r.date,
        location: r.location,
        language: r.language,
        translated_from: r.translated_from,
        source_short: r.source_short,
        best_rank: r.rank,
        hit_count: 0,
        hits: [],
      };
      events.set(r.event_id, ev);
    }
    ev.hit_count += 1;
    const content = stripShailendra(r.content);
    if (ev.hits.length < 3 && !isMetaParagraph(r.sequence_number, content)) {
      const rawHl = r.hl || r.content;
      const hl = markersToGuillemets(stripShailendra(rawHl));
      const hit: SearchHit = {
        paragraph_id: r.paragraph_id,
        sequence_number: r.sequence_number,
        content,
        hl,
      };
      if (r.role) hit.role = r.role;
      ev.hits.push(hit);
    }
  }

  // Unlimited COUNT(*) over the content-scoped query stays accurate even
  // when the main SELECT was capped by LIMIT, and (being content-scoped
  // for phrases) does not inflate a title-phrase to one-per-paragraph.
  let totalEvents: number;
  let totalHits: number;
  try {
    const row = db.get<{ ev_count: number; hit_count: number }>(
      `SELECT COUNT(DISTINCT f.event_id) AS ev_count, COUNT(*) AS hit_count
       FROM ${ftsTable} f
       LEFT JOIN events e ON e.id = f.event_id
       WHERE ${ftsTable} MATCH ?
       ${whereExtra}`,
      [countQuery, ...filterParams],
    );
    totalEvents = row?.ev_count ?? events.size;
    totalHits = row?.hit_count ?? [...events.values()].reduce((s, e) => s + e.hit_count, 0);
  } catch {
    totalEvents = events.size;
    totalHits = [...events.values()].reduce((s, e) => s + e.hit_count, 0);
  }

  // #3 — title membership for a single quoted phrase. A phrase that only
  // appears in a discourse's TITLE (the Satyam Shivam series case) must
  // still be FOUND, with a small hit_count, not one-per-paragraph.
  if (phraseInner) {
    const titleQuery = `{title_search} : (${phraseInner})`;
    let trows: Array<{
      event_id: string;
      title: string | null;
      date: string | null;
      location: string | null;
      language: string | null;
      translated_from: string | null;
      source_short: string | null;
    }>;
    try {
      trows = db.all(
        `SELECT DISTINCT f.event_id, f.title,
            e.date, e.location, e.language,
            e.translated_from AS translated_from,
            e.source_short AS source_short
         FROM ${ftsTable} f
         LEFT JOIN events e ON e.id = f.event_id
         WHERE ${ftsTable} MATCH ?
         ${whereExtra}`,
        [titleQuery, ...filterParams],
      );
    } catch {
      trows = [];
    }
    for (const r of trows) {
      if (events.has(r.event_id)) continue;
      events.set(r.event_id, {
        event_id: r.event_id,
        title: r.title,
        date: r.date,
        location: r.location,
        language: r.language,
        translated_from: r.translated_from,
        source_short: r.source_short,
        best_rank: 0.0,
        hit_count: 1,
        hits: [],
      });
      totalEvents += 1;
    }
  }

  // Apply hit-count rank bonus then sort.
  for (const ev of events.values()) {
    const hitBonus = Math.log1p(ev.hit_count || 1);
    ev.best_rank = ev.best_rank * Math.max(hitBonus, 1.0);
  }
  let out = [...events.values()].sort((a, b) => a.best_rank - b.best_rank).slice(0, limit);
  if (sort === 'title') {
    out = out.sort((a, b) => (a.title ?? '').toLowerCase().localeCompare((b.title ?? '').toLowerCase()));
  } else if (sort === 'date') {
    out = out.sort((a, b) => (a.date ?? '9999').localeCompare(b.date ?? '9999'));
  }

  return {
    query: q,
    total: totalEvents,
    total_hits: totalHits,
    events: out.map(toSearchEvent),
  };
}


function toSearchEvent(ev: MutableEvent): SearchEvent {
  return {
    event_id: ev.event_id,
    title: ev.title,
    date: ev.date,
    location: ev.location,
    language: ev.language,
    translated_from: ev.translated_from,
    source_short: ev.source_short,
    rank: ev.best_rank,
    hit_count: ev.hit_count,
    hits: ev.hits,
  };
}


// ─── Record-level All-words / Within-N (OCTP semantics) ──────────────────

/** Token count for a paragraph using the same tokenisation as
 *  `hlTokenPositions` (so record-level offsets line up with in-paragraph
 *  positions). Mirror of `_count_tokens` in cloud_api.py. */
function countTokens(text: string): number {
  return hlTokenPositions(text || '')[1];
}


/** Smallest window (max-min) containing one position from every unit's
 *  sorted list — a k-way merge over the per-unit record-level token
 *  position lists. Mirror of `_min_token_span` in cloud_api.py. */
// Returns [span, lo, hi]: the tightest window covering one position from
// each unit, and the record-level token positions bounding it (so the
// caller can map [lo, hi] back to the paragraphs forming the proximity
// hit). Mirror of _min_token_window in cloud_api.py.
function minTokenWindow(positionsPerUnit: number[][]): [number, number, number] {
  if (positionsPerUnit.some((s) => s.length === 0)) return [Number.MAX_SAFE_INTEGER, 0, 0];
  const idx = positionsPerUnit.map(() => 0);
  let maxVal = Math.max(...positionsPerUnit.map((s) => s[0]));
  let best = Number.MAX_SAFE_INTEGER;
  let bestLo = 0;
  let bestHi = 0;
  while (true) {
    let minListIdx = 0;
    let minVal = positionsPerUnit[0][idx[0]];
    for (let i = 1; i < positionsPerUnit.length; i++) {
      const v = positionsPerUnit[i][idx[i]];
      if (v < minVal) {
        minVal = v;
        minListIdx = i;
      }
    }
    if (maxVal - minVal < best) {
      best = maxVal - minVal;
      bestLo = minVal;
      bestHi = maxVal;
    }
    if (best === 0) break;
    idx[minListIdx] += 1;
    if (idx[minListIdx] >= positionsPerUnit[minListIdx].length) break;
    const newVal = positionsPerUnit[minListIdx][idx[minListIdx]];
    if (newVal > maxVal) maxVal = newVal;
  }
  return [best, bestLo, bestHi];
}


// Safety cap on how many common events we do the paragraph-gather +
// token-offset work for. Mirror of `_RECORD_LEVEL_EVENT_CAP`.
const RECORD_LEVEL_EVENT_CAP = 2000;
// Mirror of `_TOO_MANY_THRESHOLD`: flag and trim when results are this broad.
const TOO_MANY_THRESHOLD = 500;

// SQL fragment mirroring isMetaParagraph for use inside FTS MATCH queries —
// drop the title row (seq 0) and the sannyas-wiki marker so they never
// qualify a record or count as a hit. ASCII-case-insensitive LIKE covers
// the English marker. Kept in sync with _META_EXCLUDE_SQL in cloud_api.py.
// Must NOT be applied to the all-paragraphs offsets query.
const META_EXCLUDE_SQL =
  "AND f.sequence_number <> 0 AND f.content NOT LIKE 'event page in sannyas%'";


interface RecordMatchedPara {
  pid: number;
  content: string;
  role: string | null;
  hl: string;
}


/**
 * Record-level All-words / Within-N matching — TS mirror of
 * `_record_level_search` in `scripts/cloud_api.py`. See that docstring
 * for the full semantics. Returns the merged events map plus totals,
 * where total_hits is the sum over qualifying events of their matched-
 * paragraph count (guaranteeing Within-N ⊆ All-words).
 */
function recordLevelSearch(
  db: Database,
  units: string[],
  nearDist: number | null,
  whereExtra: string,
  filterParams: unknown[],
  ftsTable: string,
): { events: Map<string, MutableEvent>; totalEvents: number; totalHits: number } {
  const empty = { events: new Map<string, MutableEvent>(), totalEvents: 0, totalHits: 0 };
  if (units.length < 2) return empty;
  const useNormalised = !ftsTable.endsWith('_exact');
  const unitNorm = (s: string) => (useNormalised ? normalizeDevanagari(s) : s);
  const scopedUnits = units.map((u) => `{content} : (${unitNorm(u)})`);

  // ── Step A: per-unit event-id sets → intersect to records with ALL units.
  // Exclude meta paragraphs (title row / sannyas-wiki marker) so a record
  // that contains a unit ONLY in its metadata doesn't qualify — otherwise
  // it inflates total_events with no displayable hit. Mirrors
  // _META_EXCLUDE_SQL in cloud_api.py. The offsets query below does NOT
  // apply this (token offsets need every paragraph).
  let common: Set<string> | null = null;
  for (const su of scopedUnits) {
    let rows: Array<{ event_id: string }>;
    try {
      rows = db.all(
        `SELECT DISTINCT f.event_id
         FROM ${ftsTable} f
         LEFT JOIN events e ON e.id = f.event_id
         WHERE ${ftsTable} MATCH ?
         ${META_EXCLUDE_SQL}
         ${whereExtra}`,
        [su, ...filterParams],
      );
    } catch {
      return empty;
    }
    const ids = new Set(rows.map((r) => r.event_id));
    if (common === null) common = ids;
    else {
      const next = new Set<string>();
      for (const id of common) if (ids.has(id)) next.add(id);
      common = next;
    }
    if (common.size === 0) return empty;
  }
  if (!common || common.size === 0) return empty;

  // True qualifying-discourse count is the full intersection size —
  // capture before the cap so the "N discourses" header stays accurate
  // for broad queries (the cap only bounds gather/rank/display). Mirrors
  // cloud_api.py.
  const trueTotalEvents = common.size;
  let commonList = [...common].sort();
  if (commonList.length > RECORD_LEVEL_EVENT_CAP) {
    commonList = commonList.slice(0, RECORD_LEVEL_EVENT_CAP);
    common = new Set(commonList);
  }
  const placeholders = commonList.map(() => '?').join(',');

  // ── Step B: gather matched paragraphs for the common events only.
  const unionQuery = units.map((u) => `(${unitNorm(u)})`).join(' OR ');
  const gatherFts = `{content} : (${unionQuery})`;
  let prows: Array<{
    event_id: string;
    sequence_number: number;
    paragraph_id: number;
    content: string;
    role: string | null;
    hl: string;
  }>;
  try {
    prows = db.all(
      `SELECT
         f.event_id,
         f.sequence_number,
         f.paragraph_id,
         f.content,
         p.role AS role,
         highlight(${ftsTable}, 0, ?, ?) AS hl
       FROM ${ftsTable} f
       LEFT JOIN events e ON e.id = f.event_id
       LEFT JOIN paragraphs p ON p.id = f.paragraph_id
       WHERE ${ftsTable} MATCH ?
       AND f.event_id IN (${placeholders})
       ${whereExtra}`,
      [HL_OPEN, HL_CLOSE, gatherFts, ...commonList, ...filterParams],
    );
  } catch {
    return empty;
  }

  // event_id -> seq -> matched paragraph info. Meta paragraphs (title row
  // / sannyas-wiki marker) are dropped here so they count toward neither
  // hit_count nor total_hits nor the NEAR window — mirrors cloud_api.py
  // (the 2026-05-31 record-level bug counted them in the totals while
  // hiding them from the snippets).
  const matched = new Map<string, Map<number, RecordMatchedPara>>();
  for (const r of prows) {
    if (isMetaParagraph(r.sequence_number, r.content)) continue;
    let m = matched.get(r.event_id);
    if (!m) { m = new Map(); matched.set(r.event_id, m); }
    m.set(r.sequence_number, {
      pid: r.paragraph_id,
      content: r.content,
      role: r.role,
      hl: r.hl,
    });
  }

  // For NEAR: per-unit in-paragraph positions, restricted to common events.
  // event_id -> unit_index -> seq -> positions
  const perUnitPos = new Map<string, Map<number, Map<number, number[]>>>();
  const offsets = new Map<string, Map<number, number>>();
  if (nearDist !== null) {
    for (let ui = 0; ui < scopedUnits.length; ui++) {
      let urows: Array<{ event_id: string; sequence_number: number; hl: string; content: string }>;
      try {
        urows = db.all(
          `SELECT f.event_id, f.sequence_number,
             highlight(${ftsTable}, 0, ?, ?) AS hl, f.content
           FROM ${ftsTable} f
           LEFT JOIN events e ON e.id = f.event_id
           WHERE ${ftsTable} MATCH ?
           AND f.event_id IN (${placeholders})
           ${whereExtra}`,
          [HL_OPEN, HL_CLOSE, scopedUnits[ui], ...commonList, ...filterParams],
        );
      } catch {
        return empty;
      }
      for (const r of urows) {
        if (isMetaParagraph(r.sequence_number, r.content)) continue;
        const [positions] = hlTokenPositions(r.hl || r.content);
        if (!positions.length) continue;
        let byUnit = perUnitPos.get(r.event_id);
        if (!byUnit) { byUnit = new Map(); perUnitPos.set(r.event_id, byUnit); }
        let bySeq = byUnit.get(ui);
        if (!bySeq) { bySeq = new Map(); byUnit.set(ui, bySeq); }
        bySeq.set(r.sequence_number, positions);
      }
    }

    // Record-level token offset of each paragraph = sum of token counts of
    // all earlier paragraphs (by sequence_number) in the discourse. Need
    // counts for EVERY paragraph, not just matched ones.
    const allp = db.all<{ event_id: string; sequence_number: number; content: string }>(
      `SELECT event_id, sequence_number, content FROM paragraphs
       WHERE event_id IN (${placeholders}) ORDER BY event_id, sequence_number`,
      commonList,
    );
    const byEv = new Map<string, Array<[number, string]>>();
    for (const r of allp) {
      let arr = byEv.get(r.event_id);
      if (!arr) { arr = []; byEv.set(r.event_id, arr); }
      arr.push([r.sequence_number, r.content]);
    }
    for (const [evId, plist] of byEv) {
      plist.sort((a, b) => a[0] - b[0]);
      let running = 0;
      const seqOff = new Map<number, number>();
      for (const [seq, content] of plist) {
        seqOff.set(seq, running);
        running += countTokens(content);
      }
      offsets.set(evId, seqOff);
    }
  }

  const events = new Map<string, MutableEvent>();
  let totalHits = 0;
  for (const evId of common) {
    const paraMap = matched.get(evId);
    if (!paraMap || paraMap.size === 0) continue;

    // display_seqs: which paragraphs to show + count. All-words → every
    // matched paragraph; Within-N → narrowed to the proximity-window
    // paragraphs below. Mirror of cloud_api.py.
    let displaySeqs = [...paraMap.keys()].sort((a, b) => a - b);

    if (nearDist !== null) {
      const unitPos = perUnitPos.get(evId);
      const seqOff = offsets.get(evId) ?? new Map<number, number>();
      const positionsPerUnit: number[][] = [];
      const posSeq = new Map<number, number>();
      let ok = true;
      for (let ui = 0; ui < units.length; ui++) {
        const bySeq = unitPos?.get(ui);
        if (!bySeq || bySeq.size === 0) { ok = false; break; }
        const recPositions: number[] = [];
        for (const [seq, plist] of bySeq) {
          const base = seqOff.get(seq);
          if (base === undefined) continue; // stale FTS entry - skip to avoid false NEAR matches
          for (const p of plist) { const rp = base + p; recPositions.push(rp); posSeq.set(rp, seq); }
        }
        if (!recPositions.length) { ok = false; break; }
        recPositions.sort((a, b) => a - b);
        positionsPerUnit.push(recPositions);
      }
      if (!ok) continue;
      const [span, lo, hi] = minTokenWindow(positionsPerUnit);
      if (span > nearDist) continue;
      const windowSeqs = [...new Set(
        [...posSeq.entries()].filter(([p]) => p >= lo && p <= hi).map(([, s]) => s),
      )].sort((a, b) => a - b);
      const inMap = windowSeqs.filter((s) => paraMap.has(s));
      displaySeqs = inMap;
    }

    const evRow = db.get<{
      title: string | null;
      date: string | null;
      location: string | null;
      language: string | null;
      translated_from: string | null;
      source_short: string | null;
    }>(
      'SELECT title, date, location, language, translated_from, source_short'
      + ' FROM events WHERE id = ?',
      [evId],
    );
    if (!evRow) continue;

    // All-words → per-paragraph hit count; Within-N → 1 passage per
    // discourse (matches OCTP's within-N counts). Mirror of cloud_api.py.
    const hitCount = nearDist !== null ? 1 : paraMap.size;
    totalHits += hitCount;

    const hits: SearchHit[] = [];
    for (const seq of displaySeqs) {
      if (hits.length >= 3) break;
      const info = paraMap.get(seq);
      if (!info) continue;
      const content = stripShailendra(info.content || '');
      // paraMap is already meta-filtered at gather time.
      const rawHl = info.hl || info.content;
      const hl = markersToGuillemets(stripShailendra(rawHl || ''));
      const hit: SearchHit = {
        paragraph_id: info.pid,
        sequence_number: seq,
        content,
        hl,
      };
      if (info.role) hit.role = info.role;
      hits.push(hit);
    }

    events.set(evId, {
      event_id: evId,
      title: evRow.title,
      date: evRow.date,
      location: evRow.location,
      language: evRow.language,
      translated_from: evRow.translated_from,
      source_short: evRow.source_short,
      best_rank: 0.0,
      hit_count: hitCount,
      hits,
    });
  }

  // totalEvents is the true intersection size (pre-cap); totalHits is
  // summed over the gathered (possibly capped) events. Exact below the
  // cap; above it the discourse count stays accurate while totalHits is a
  // lower bound. Mirrors cloud_api.py.
  // totalEvents: All-words → true intersection size (pre-cap); Within-N →
  // discourses that passed the proximity window. Mirror of cloud_api.py.
  const totalEvents = nearDist !== null ? events.size : trueTotalEvents;
  return { events, totalEvents, totalHits };
}


// ─── Internal event accumulator ──────────────────────────────────────────

interface MutableEvent {
  event_id: string;
  title: string | null;
  date: string | null;
  location: string | null;
  language: string | null;
  translated_from: string | null;
  source_short: string | null;
  best_rank: number;
  hit_count: number;
  hits: SearchHit[];
}


// ─── discourse() ─────────────────────────────────────────────────────────

export interface DiscourseOptions {
  title?: string;
  eventId?: string;
  /** If provided, include FTS5 highlight markers on matching paragraphs. */
  q?: string;
  /** When true, highlight against the un-stemmed exact index (mirrors search exact mode). */
  exact?: boolean;
}

interface DiscourseEventRow {
  id: string;
  title: string | null;
  date: string | null;
  location: string | null;
  language: string | null;
  translated_from: string | null;
  source_short: string | null;
}

export function discourse(db: Database, opts: DiscourseOptions): DiscourseResponse {
  const { title, eventId, q, exact } = opts;
  if (!title && !eventId) throw new SearchError('Provide title or event_id', 400);

  const evRow = eventId
    ? db.get<DiscourseEventRow>(
        'SELECT id, title, date, location, language, translated_from, source_short'
        + ' FROM events WHERE id = ?',
        [eventId],
      )
    : db.get<DiscourseEventRow>(
        'SELECT id, title, date, location, language, translated_from, source_short'
        + " FROM events WHERE title = ? ORDER BY COALESCE(date, '') LIMIT 1",
        [title!],
      );
  if (!evRow) throw new SearchError('Discourse not found', 404);

  const paraRows = db.all<{ id: number; sequence_number: number; content: string; role: string | null }>(
    'SELECT id, sequence_number, content, role FROM paragraphs WHERE event_id = ? ORDER BY sequence_number',
    [evRow.id],
  );

  const ftsTable = exact ? 'paragraphs_fts_exact' : 'paragraphs_fts';
  const hlMap = new Map<number, string>();
  if (q) {
    const ftsQuery = rewriteQuery(q, { exact: exact ?? false });
    try {
      const hlRows = db.all<{ paragraph_id: number; hl: string }>(
        `SELECT f.paragraph_id, highlight(${ftsTable}, 0, ?, ?) AS hl
         FROM ${ftsTable} f
         WHERE ${ftsTable} MATCH ?
           AND f.event_id = ?`,
        [HL_OPEN, HL_CLOSE, ftsQuery, evRow.id],
      );
      for (const row of hlRows) {
        hlMap.set(row.paragraph_id, markersToGuillemets(stripShailendra(row.hl || '')));
      }
    } catch {
      // FTS unavailable / invalid query — silently skip highlighting.
    }
  }

  const paragraphs: DiscourseParagraph[] = paraRows.map((r) => {
    const out: DiscourseParagraph = {
      sequence_number: r.sequence_number,
      content: stripShailendra(r.content),
    };
    if (r.role) out.role = r.role;
    if (hlMap.has(r.id)) out.hl = hlMap.get(r.id);
    return out;
  });

  return {
    event: {
      id: evRow.id,
      title: evRow.title,
      date: evRow.date,
      location: evRow.location,
      language: evRow.language,
      translated_from: evRow.translated_from,
      source_short: evRow.source_short,
    },
    paragraphs,
  };
}


// ─── catalog() / languages() / dateRange() ──────────────────────────────

export interface CatalogEvent {
  id: string;
  title: string | null;
  date: string | null;
  location: string | null;
  language: string | null;
  translated_from?: string | null;
  source_short?: string | null;
  tags: string[];
}

export interface CatalogResponse {
  events: CatalogEvent[];
}

export function catalog(db: Database): CatalogResponse {
  const rows = db.all<{
    id: string;
    title: string | null;
    date: string | null;
    location: string | null;
    language: string | null;
    translated_from: string | null;
    source_short: string | null;
  }>(
    'SELECT id, title, date, location, language, translated_from, source_short'
    + " FROM events WHERE title IS NOT NULL ORDER BY COALESCE(date, ''), title",
  );

  // event_tags is optional — older DBs don't have it. Probe before
  // querying so the call doesn't throw on legacy archives.
  const hasTags = !!db.get<{ name: string }>(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='event_tags'",
  );

  const tagsByEvent = new Map<string, string[]>();
  if (hasTags) {
    const tagRows = db.all<{ event_id: string; tag: string }>(
      'SELECT event_id, tag FROM event_tags',
    );
    for (const r of tagRows) {
      const arr = tagsByEvent.get(r.event_id);
      if (arr) arr.push(r.tag);
      else tagsByEvent.set(r.event_id, [r.tag]);
    }
    for (const arr of tagsByEvent.values()) arr.sort();
  }

  return {
    events: rows.map((r) => ({
      id: r.id,
      title: r.title,
      date: r.date,
      location: r.location,
      language: r.language,
      translated_from: r.translated_from,
      source_short: r.source_short,
      tags: tagsByEvent.get(r.id) ?? [],
    })),
  };
}


export interface LanguagesResponse { languages: string[] }

export function languages(db: Database): LanguagesResponse {
  const rows = db.all<{ language: string }>(
    'SELECT DISTINCT language FROM events'
    + ' WHERE language IS NOT NULL ORDER BY language',
  );
  return { languages: rows.map((r) => r.language) };
}


export interface DateRangeResponse {
  min_year: string | null;
  max_year: string | null;
}

export function dateRange(db: Database): DateRangeResponse {
  // Mirror the year-range filter's first/last extraction so a "1971/1972 ?"
  // record contributes 1972 to MAX. The same expression must live in both
  // engines (cloud_api.py + here) for parity per CLAUDE.md.
  const row = db.get<{ min: string | null; max: string | null }>(
    'SELECT MIN(SUBSTR(date,1,4)) AS min,'
    + " MAX(CASE WHEN INSTR(date, '/') > 0"
    + '          THEN SUBSTR(date, INSTR(date, \'/\') + 1, 4)'
    + '          ELSE SUBSTR(date, 1, 4) END) AS max'
    + ' FROM events WHERE date IS NOT NULL AND LENGTH(date) >= 4',
  );
  return { min_year: row?.min ?? null, max_year: row?.max ?? null };
}


// ─── Errors ──────────────────────────────────────────────────────────────

/** Mirror of scripts/cloud_api.py:_LANGUAGE_ALIASES — keep them in sync. */
const LANGUAGE_ALIASES: Record<string, string[]> = {
  english: ['English', 'en', 'EN'],
  hindi: ['Hindi', 'hi', 'HI'],
  en: ['English', 'en', 'EN'],
  hi: ['Hindi', 'hi', 'HI'],
};

function expandLanguageAliases(language: string): string[] {
  const key = (language || '').trim().toLowerCase();
  return LANGUAGE_ALIASES[key] ?? [language];
}


export class SearchError extends Error {
  constructor(message: string, public readonly status: number) {
    super(message);
    this.name = 'SearchError';
  }
}
