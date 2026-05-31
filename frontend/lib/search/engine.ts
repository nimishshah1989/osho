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
import { parseNear, rewriteQuery, scopeWordToContent } from './queryRewrite';
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
  if (language) {
    // Accept both full names and ISO codes — see cloud_api.py's
    // `_expand_language_aliases` for the same logic. Keeps the offline
    // engine tolerant to whatever the DB happens to hold.
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
      [HL_OPEN, HL_CLOSE, ftsQuery, ...filterParams, limit * 10],
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

  // Cross-paragraph augmentation for NEAR queries.
  let augmentedCrossPara = false;
  if (nearParsed) {
    if (nearParsed.words.length >= 2) {
      const adj = augmentNearAdjacentStrict(
        db, nearParsed.words, nearParsed.distance, whereExtra, filterParams, ftsTable,
      );
      for (const [evId, cev] of adj) {
        if (!events.has(evId)) {
          events.set(evId, cev);
          augmentedCrossPara = true;
        }
      }
    }
    if (nearParsed.distance >= 100) {
      const paraSpan = Math.max(1, Math.floor(nearParsed.distance / 30));
      const cross = augmentNearCrossParagraph(
        db, nearParsed.words, paraSpan, whereExtra, filterParams, ftsTable,
      );
      for (const [evId, cev] of cross) {
        if (!events.has(evId)) {
          events.set(evId, cev);
          augmentedCrossPara = true;
        }
      }
    }
  }

  // Count strategy: when cross-paragraph augmentation produced new
  // events, sum from the merged dict; otherwise, derive from an
  // unlimited COUNT(*) so the total stays accurate even when the
  // main SELECT was capped by LIMIT.
  let totalEvents: number;
  let totalHits: number;
  if (augmentedCrossPara) {
    totalEvents = events.size;
    totalHits = [...events.values()].reduce((s, e) => s + e.hit_count, 0);
  } else {
    try {
      const row = db.get<{ ev_count: number; hit_count: number }>(
        `SELECT COUNT(DISTINCT f.event_id) AS ev_count, COUNT(*) AS hit_count
         FROM ${ftsTable} f
         LEFT JOIN events e ON e.id = f.event_id
         WHERE ${ftsTable} MATCH ?
         ${whereExtra}`,
        [ftsQuery, ...filterParams],
      );
      totalEvents = row?.ev_count ?? events.size;
      totalHits = row?.hit_count ?? [...events.values()].reduce((s, e) => s + e.hit_count, 0);
    } catch {
      totalEvents = events.size;
      totalHits = [...events.values()].reduce((s, e) => s + e.hit_count, 0);
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
  }

  const events_out: SearchEvent[] = out.map((ev) => ({
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
  }));

  return {
    query: q,
    total: totalEvents,
    total_hits: totalHits,
    events: events_out,
  };
}


// ─── Cross-paragraph NEAR augmentation ───────────────────────────────────

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


interface WordParaInfo {
  pid: number;
  content: string;
  role: string | null;
  positions: number[];
  token_count: number;
}


function augmentNearAdjacentStrict(
  db: Database,
  words: string[],
  nearDist: number,
  whereExtra: string,
  filterParams: unknown[],
  ftsTable: string,
): Map<string, MutableEvent> {
  if (words.length < 2) return new Map();
  const useNormalised = !ftsTable.endsWith('_exact');
  const wordNorm = (s: string) => (useNormalised ? normalizeDevanagari(s) : s);

  // per-word: event_id -> seq -> info
  const perWord: Array<Map<string, Map<number, WordParaInfo>>> = [];
  for (const word of words) {
    const wordFts = scopeWordToContent(wordNorm(word));
    let wrows: Array<{
      event_id: string;
      sequence_number: number;
      paragraph_id: number;
      content: string;
      role: string | null;
      hl: string;
    }>;
    try {
      wrows = db.all(
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
         ${whereExtra}`,
        [HL_OPEN, HL_CLOSE, wordFts, ...filterParams],
      );
    } catch {
      return new Map();
    }
    const perEv = new Map<string, Map<number, WordParaInfo>>();
    for (const r of wrows) {
      const [positions, total] = hlTokenPositions(r.hl || r.content);
      if (!positions.length) continue;
      let seqMap = perEv.get(r.event_id);
      if (!seqMap) {
        seqMap = new Map();
        perEv.set(r.event_id, seqMap);
      }
      seqMap.set(r.sequence_number, {
        pid: r.paragraph_id,
        content: r.content,
        role: r.role,
        positions,
        token_count: total,
      });
    }
    perWord.push(perEv);
  }

  if (perWord.some((m) => m.size === 0)) return new Map();

  // Events that contain every query word in at least one paragraph.
  let commonIds = new Set<string>(perWord[0].keys());
  for (let i = 1; i < perWord.length; i++) {
    const next = new Set<string>();
    for (const id of commonIds) if (perWord[i].has(id)) next.add(id);
    commonIds = next;
  }

  const events = new Map<string, MutableEvent>();
  for (const evId of commonIds) {
    // For each consecutive pair (seq_x, seq_x+1) where the union of word
    // matches covers all N query words, compute the conservative span
    // across the two paragraphs and keep the tightest match. The 2-word
    // case is just N=2 of this same algorithm (Sugit 2026-05-31).
    const seqsPerWord = perWord.map((m) => new Set(m.get(evId)?.keys() ?? []));
    const seqsAny = new Set<number>();
    for (const s of seqsPerWord) for (const v of s) seqsAny.add(v);

    let bestSpan = nearDist + 1;
    let bestPair: { sx: number; sy: number } | null = null;
    for (const sx of seqsAny) {
      const sy = sx + 1;
      if (!seqsAny.has(sy)) continue;
      const infoX: Array<WordParaInfo | undefined> = perWord.map(
        (m) => m.get(evId)?.get(sx),
      );
      const infoY: Array<WordParaInfo | undefined> = perWord.map(
        (m) => m.get(evId)?.get(sy),
      );
      const tokenCountX = (infoX.find((v) => v) || infoY.find((v) => v))?.token_count ?? 0;
      let coversX = false;
      let coversY = false;
      let minPos = Infinity;
      let maxPos = -Infinity;
      let coveredAll = true;
      for (let i = 0; i < words.length; i++) {
        const positions: number[] = [];
        if (infoX[i]) { positions.push(...infoX[i]!.positions); coversX = true; }
        if (infoY[i]) {
          positions.push(...infoY[i]!.positions.map((p) => p + tokenCountX));
          coversY = true;
        }
        if (!positions.length) { coveredAll = false; break; }
        minPos = Math.min(minPos, ...positions);
        maxPos = Math.max(maxPos, ...positions);
      }
      // Skip when all words actually sit in one paragraph — FTS5's in-row
      // NEAR handles that case already; counting it here double-counts.
      if (!coveredAll || !(coversX && coversY)) continue;
      const span = maxPos - minPos;
      if (span <= nearDist && span < bestSpan) {
        bestSpan = span;
        bestPair = { sx, sy };
      }
    }
    if (!bestPair) continue;

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

    // Build display hits: one entry per paragraph in the matched pair
    // that actually contributed a word.
    const hits: SearchHit[] = [];
    for (const seq of [bestPair.sx, bestPair.sy]) {
      let info: WordParaInfo | undefined;
      for (let i = 0; i < words.length; i++) {
        const v = perWord[i].get(evId)?.get(seq);
        if (v) { info = v; break; }
      }
      if (!info) continue;
      const content = stripShailendra(info.content || '');
      if (isMetaParagraph(seq, content)) continue;
      const hit: SearchHit = {
        paragraph_id: info.pid,
        sequence_number: seq,
        content,
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
      hit_count: words.length,
      hits,
    });
  }

  return events;
}


function augmentNearCrossParagraph(
  db: Database,
  words: string[],
  paraSpan: number,
  whereExtra: string,
  filterParams: unknown[],
  ftsTable: string,
): Map<string, MutableEvent> {
  const useNormalised = !ftsTable.endsWith('_exact');
  const wordNorm = (s: string) => (useNormalised ? normalizeDevanagari(s) : s);

  // per-word: event_id -> sorted list of sequence_numbers
  const perWord: Array<Map<string, number[]>> = [];
  for (const word of words) {
    const wordFts = scopeWordToContent(wordNorm(word));
    let wrows: Array<{ event_id: string; sequence_number: number }>;
    try {
      wrows = db.all(
        `SELECT f.event_id, f.sequence_number
         FROM ${ftsTable} f
         LEFT JOIN events e ON e.id = f.event_id
         WHERE ${ftsTable} MATCH ?
         ${whereExtra}`,
        [wordFts, ...filterParams],
      );
    } catch {
      return new Map();
    }
    const m = new Map<string, number[]>();
    for (const r of wrows) {
      const arr = m.get(r.event_id);
      if (arr) arr.push(r.sequence_number);
      else m.set(r.event_id, [r.sequence_number]);
    }
    for (const seqs of m.values()) seqs.sort((a, b) => a - b);
    perWord.push(m);
  }

  if (!perWord.length) return new Map();

  // Intersect event ids
  let commonIds = new Set(perWord[0].keys());
  for (const m of perWord.slice(1)) {
    const next = new Set<string>();
    for (const id of commonIds) if (m.has(id)) next.add(id);
    commonIds = next;
  }

  const events = new Map<string, MutableEvent>();
  for (const evId of commonIds) {
    const seqsPerWord = perWord.map((m) => m.get(evId)!);
    const span = minParaSpan(seqsPerWord);
    if (span > paraSpan) continue;

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

    const allSeqs: number[] = [];
    for (const seqs of seqsPerWord) allSeqs.push(...seqs);
    const uniqueSeqs = [...new Set(allSeqs)].sort((a, b) => a - b).slice(0, 5);

    const hits: SearchHit[] = [];
    for (const seq of uniqueSeqs) {
      if (hits.length >= 3) break;
      const para = db.get<{ id: number; content: string }>(
        'SELECT id, content FROM paragraphs WHERE event_id = ? AND sequence_number = ?',
        [evId, seq],
      );
      if (!para) continue;
      const content = stripShailendra(para.content || '');
      if (isMetaParagraph(seq, content)) continue;
      hits.push({
        paragraph_id: para.id,
        sequence_number: seq,
        content,
      });
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
      hit_count: uniqueSeqs.length,
      hits,
    });
  }

  return events;
}


/** Minimum window-span across one chosen index from each list — same
 *  algorithm as `_min_para_span` in cloud_api.py. Used for the loose
 *  paragraph-distance heuristic that fires only at NEAR(...) ≥ 100. */
function minParaSpan(seqsPerWord: number[][]): number {
  if (seqsPerWord.some((s) => s.length === 0)) return Number.MAX_SAFE_INTEGER;
  // Cursors into each sorted list
  const idx = seqsPerWord.map(() => 0);
  let maxVal = Math.max(...seqsPerWord.map((s) => s[0]));
  let best = Number.MAX_SAFE_INTEGER;
  while (true) {
    // Find the list whose cursor points at the minimum
    let minListIdx = 0;
    let minVal = seqsPerWord[0][idx[0]];
    for (let i = 1; i < seqsPerWord.length; i++) {
      const v = seqsPerWord[i][idx[i]];
      if (v < minVal) {
        minVal = v;
        minListIdx = i;
      }
    }
    best = Math.min(best, maxVal - minVal);
    if (best === 0) break;
    idx[minListIdx] += 1;
    if (idx[minListIdx] >= seqsPerWord[minListIdx].length) break;
    const newVal = seqsPerWord[minListIdx][idx[minListIdx]];
    if (newVal > maxVal) maxVal = newVal;
  }
  return best;
}


// ─── discourse() ─────────────────────────────────────────────────────────

export interface DiscourseOptions {
  title?: string;
  eventId?: string;
  /** If provided, include FTS5 highlight markers on matching paragraphs. */
  q?: string;
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
  const { title, eventId, q } = opts;
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

  const hlMap = new Map<number, string>();
  if (q) {
    const ftsQuery = rewriteQuery(q);
    try {
      const hlRows = db.all<{ paragraph_id: number; hl: string }>(
        `SELECT f.paragraph_id, highlight(paragraphs_fts, 0, ?, ?) AS hl
         FROM paragraphs_fts f
         WHERE paragraphs_fts MATCH ?
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
