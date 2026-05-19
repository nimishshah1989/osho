/**
 * Public entry point for the offline search stack.
 *
 * One call to `openOfflineDatabase()` returns either a ready-to-use
 * `Database` the engine can run against, or a structured "not yet"
 * state the UI can react to (offer the download, show a progress bar,
 * or fall back to the online API).
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

export { corpusExistsInOpfs, downloadAndInstallCorpus, DbLoadError } from './dbLoader';
export type { ProgressEvent as DownloadProgress, LoadOptions } from './dbLoader';
export { openOpfsDatabase } from './opfsAdapter';
export type { OpfsStatus } from './opfsAdapter';

import { corpusExistsInOpfs } from './dbLoader';
import { openOpfsDatabase, type OpfsStatus } from './opfsAdapter';


/** Convenience wrapper: returns `ready` immediately if the corpus is
 *  already in OPFS; otherwise returns `needs-download` so the UI can
 *  trigger `downloadAndInstallCorpus()` and call us back. */
export type OfflineState =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'needs-download' }
  | OpfsStatus;


export async function openOfflineDatabase(opfsFilename: string): Promise<OfflineState> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    return { kind: 'unsupported', reason: 'OPFS not available in this browser.' };
  }
  const exists = await corpusExistsInOpfs(opfsFilename);
  if (!exists) return { kind: 'needs-download' };
  return openOpfsDatabase(opfsFilename);
}
