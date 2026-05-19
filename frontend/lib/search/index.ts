/**
 * Public entry point for the offline search stack.
 *
 * The engine + the offline runtime have different lifecycles:
 *
 *   - `engine.ts` is pure logic over a `Database`. Tests import it
 *     directly and back it with `better-sqlite3` in node.
 *
 *   - `worker/client.ts` runs the engine inside a Web Worker against
 *     sqlite-wasm + OPFS. UI components import from here. The async
 *     API mirrors the sync engine — `search(opts) → Promise<...>`.
 *
 * Why both: the engine can be unit-tested fast and serverside, and
 * the offline runtime stays cleanly factored behind the worker
 * boundary. Sharing the same `engine.ts` between node tests and the
 * worker means there's only ever one search implementation.
 */
export { search, discourse, SearchError } from './engine';
export type { DiscourseOptions } from './engine';
export type {
  Database,
  SearchOptions,
  SearchResponse,
  SearchEvent,
  SearchHit,
  DiscourseResponse,
  DiscourseParagraph,
} from './types';
export { normalizeDevanagari } from './devanagari';
export { rewriteQuery, parseNear } from './queryRewrite';
export { hlTokenPositions, markersToGuillemets } from './highlight';

// Offline runtime (browser-only — main-thread RPC client wrapping the
// sqlite-wasm + OPFS worker).
export {
  corpusExistsInOpfs,
  installCorpus,
  openOfflineEngine,
} from './worker/client';
export type {
  OfflineEngine,
  OfflineState,
  ProgressUpdate,
} from './worker/client';
