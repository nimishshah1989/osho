/** Shapes the search engine exposes to its callers (UI components) and
 *  shapes it expects from its database backend. Kept aligned with the
 *  JSON the FastAPI backend currently returns so the same React code
 *  works against either implementation.
 */

export interface SearchHit {
  paragraph_id: number;
  sequence_number: number;
  content: string;
  /** FTS5-highlighted content with «…» around matched terms. */
  hl?: string;
  role?: string;
}

export interface SearchEvent {
  event_id: string;
  title: string | null;
  date: string | null;
  location: string | null;
  language: string | null;
  /** "none" / null for originals; the source-language name (e.g. "Hindi")
   *  for records that were translated. Mirrors `events.translated_from`. */
  translated_from?: string | null;
  /** Short book title — set only when this record is a translation; the
   *  UI shows it alongside "translated from X" so the reader can see
   *  which published volume the translation came from. */
  source_short?: string | null;
  rank: number;
  hit_count: number;
  hits: SearchHit[];
}

export interface SearchResponse {
  query: string;
  total: number;
  total_hits: number;
  events: SearchEvent[];
}

export interface SearchOptions {
  q: string;
  limit?: number;
  sort?: 'rank' | 'title';
  language?: string;
  /** When true, restrict to records with translated_from NULL/'none'. */
  original?: boolean;
  /** When true, hit the un-stemmed FTS index. */
  exact?: boolean;
  /** YYYY or YYYY-MM-DD. */
  dateFrom?: string;
  /** YYYY or YYYY-MM-DD. */
  dateTo?: string;
}

export interface DiscourseParagraph {
  sequence_number: number;
  content: string;
  role?: string;
  hl?: string;
}

export interface DiscourseEventMeta {
  id: string;
  title: string | null;
  date: string | null;
  location: string | null;
  language: string | null;
  translated_from?: string | null;
  source_short?: string | null;
}

export interface DiscourseResponse {
  event: DiscourseEventMeta;
  paragraphs: DiscourseParagraph[];
}

// ─── Database abstraction ─────────────────────────────────────────────

/**
 * Minimal database interface. Lets us run the engine against
 * `better-sqlite3` in node tests and against `sqlite-wasm` in the
 * desktop runtime without changing the engine itself.
 */
export interface Database {
  /** Parameterised query returning rows as objects keyed by column name. */
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): T[];
  /** Same but returning a single row or undefined. */
  get<T = Record<string, unknown>>(sql: string, params?: unknown[]): T | undefined;
}
