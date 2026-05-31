/**
 * Query rewriting — TS counterpart of `_rewrite_query`, `_parse_near`,
 * and the column-filter / phrase-only / title-shortcut handling in
 * `scripts/cloud_api.py`. Keep behaviour identical with the backend
 * so the desktop app's results match the web app's exactly.
 */
import { normalizeDevanagari } from './devanagari';

// `title:foo` → `title_search:foo`, mirrors `_TITLE_FILTER_RE` on the
// backend. The literal `title_search` is the indexed column name on
// the FTS5 schema.
const TITLE_FILTER_RE = /\btitle\s*:\s*/gi;

// A query that's exactly one quoted phrase and nothing else. Phrase
// mode keeps the title column searchable because that's how a user
// looks up a series by name (Sugit 2026-05-16).
const PHRASE_ONLY_RE = /^\s*"[^"]+"\s*$/;

// Strip the column-filter wrapper put on by `rewriteQuery` so
// `parseNear` can still find a NEAR(...) inside `{content} : (...)`.
const COLUMN_FILTER_WRAP_RE = /^\s*\{[^}]+\}\s*:\s*\((.+)\)\s*$/s;

const NEAR_RE = /^NEAR\s*\(\s*(.+?)\s*,\s*(\d+)\s*\)\s*$/i;


export interface RewriteOptions {
  /** When true, skip the Devanagari nasal+virama → anusvara collapse so
   *  the query matches the un-stemmed / un-normalised FTS index that
   *  the Exact toggle hits. Default false (= stemmed/normalised). */
  exact?: boolean;
}


/**
 * Normalise the user's query for FTS5.
 *
 * - Rewrites `title:foo` to `title_search:foo` so the explicit
 *   title-lookup shortcut still works.
 * - In non-exact mode, applies Devanagari nasal+virama → anusvara
 *   normalisation so spelling variants find each other.
 * - Scopes the FTS match to the `content` column unless the query is
 *   already a `title:` filter or a literal phrase. Without this scope a
 *   bag-of-words query like "Satyam Shivam" balloons hit counts by
 *   matching the whole `Satyam Shivam Sundaram` series via title.
 *
 * Returns the empty string when given the empty string.
 */
export function rewriteQuery(userQuery: string, opts: RewriteOptions = {}): string {
  let q = userQuery.replace(TITLE_FILTER_RE, 'title_search:').trim();
  if (!opts.exact) q = normalizeDevanagari(q);
  if (!q) return q;
  if (q.includes('title_search:') || PHRASE_ONLY_RE.test(q)) return q;
  // An apostrophe in an un-quoted term ("women's") is a hard FTS5 grammar
  // error. The unicode61 tokenizer splits on apostrophe at index time
  // (women's → women + s), so replacing it with a space yields the same
  // tokens without the crash. Mirrors _rewrite_query in cloud_api.py.
  // Phrases keep their apostrophes (handled by the early return above).
  q = q.replace(/[’']/g, ' ').trim();
  // A query of nothing but apostrophes collapses to empty here — return
  // empty rather than wrapping `{content} : ()`, which FTS5 also rejects.
  if (!q) return '';
  return `{content} : (${q})`;
}


export interface NearQuery {
  words: string[];
  /** Maximum FTS5 NEAR distance the user asked for. */
  distance: number;
}


/**
 * Detect a NEAR(...) query and pull out its words and distance.
 * Tolerates the column-filter wrap `rewriteQuery` may have applied.
 * Returns null when the query isn't a NEAR.
 */
export function parseNear(ftsQuery: string): NearQuery | null {
  let q = ftsQuery.trim();
  const wrap = q.match(COLUMN_FILTER_WRAP_RE);
  if (wrap) q = wrap[1].trim();
  const m = q.match(NEAR_RE);
  if (!m) return null;
  const wordsRaw = m[1];
  const distance = parseInt(m[2], 10);
  const words = wordsRaw
    .split(/\s+/)
    .map((w) => w.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  if (words.length < 2) return null;
  return { words, distance };
}


/** Wrap a single-word FTS5 query in the same column-scope filter
 *  `rewriteQuery` applies. Used by the per-word lookups inside the
 *  cross-paragraph NEAR augmentation so title-only word matches don't
 *  leak into the augmentation either. */
export function scopeWordToContent(word: string): string {
  return `{content} : (${word})`;
}
