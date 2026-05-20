/**
 * Main-thread RPC client for the OPFS / sqlite-wasm worker.
 *
 * Hides the postMessage machinery behind a small async API the UI can
 * await directly. One worker per page (spawned lazily on the first
 * call). Every request gets a monotonically-increasing id so concurrent
 * calls don't cross wires; the worker echoes the id back on each reply.
 *
 * Two flavours of reply land:
 *
 *   - terminal (`{ok:true|false, ...}`) — resolves / rejects the
 *     pending promise and removes it from the pending map.
 *   - progress (`{progress:{...}}`) — fed to the request's
 *     `onProgress` callback without resolving the promise.
 *
 * Errors carry a `kind` discriminant so the UI can show specific
 * messages ("no space on device", "DB file corrupt", "network down")
 * rather than a generic failure modal.
 */
import { SearchError } from '../engine';
import type {
  DiscourseResponse,
  SearchOptions,
  SearchResponse,
} from '../types';
import type {
  CatalogResponse,
  DateRangeResponse,
  DiscourseOptions,
  LanguagesResponse,
} from '../engine';
import type {
  ProgressUpdate,
  WorkerReply,
  WorkerRequest,
} from './dbWorker';

export type { ProgressUpdate };


/** Async equivalent of the sync engine API. The UI uses this. */
export interface OfflineEngine {
  search(opts: SearchOptions): Promise<SearchResponse>;
  discourse(opts: DiscourseOptions): Promise<DiscourseResponse>;
  catalog(): Promise<CatalogResponse>;
  languages(): Promise<LanguagesResponse>;
  dateRange(): Promise<DateRangeResponse>;
  close(): Promise<void>;
}


/** State returned by `openOfflineEngine` so the UI can decide what to
 *  render: a ready engine, a "needs download" prompt, or a banner
 *  explaining the browser can't do offline. */
export type OfflineState =
  | { kind: 'ready'; engine: OfflineEngine }
  | { kind: 'needs-download' }
  | { kind: 'unsupported'; reason: string };


// ─── Singleton client ────────────────────────────────────────────────────

type Resolver = {
  resolve: (data: unknown) => void;
  reject: (e: Error) => void;
  onProgress?: (p: ProgressUpdate) => void;
};

let workerSingleton: Worker | null = null;
let nextId = 1;
const pending = new Map<number, Resolver>();

function ensureWorker(): Worker {
  if (workerSingleton) return workerSingleton;
  // `new URL(..., import.meta.url)` is the Webpack 5 / Next.js convention
  // for spawning a worker file from a source module — the bundler
  // compiles it as a separate entry. `type: 'module'` is required so
  // top-level imports in the worker resolve.
  workerSingleton = new Worker(
    new URL('./dbWorker.ts', import.meta.url),
    { type: 'module' },
  );
  workerSingleton.onmessage = (e: MessageEvent<WorkerReply>) => {
    const msg = e.data;
    const slot = pending.get(msg.id);
    if (!slot) return;
    if ('progress' in msg) {
      slot.onProgress?.(msg.progress);
      return;
    }
    pending.delete(msg.id);
    if (msg.ok) {
      slot.resolve(msg.data);
    } else {
      const err = new SearchError(msg.message, kindToStatus(msg.kind));
      (err as unknown as { kind: string }).kind = msg.kind;
      slot.reject(err);
    }
  };
  workerSingleton.onerror = (e) => {
    // Unhandled exception from the worker — fail every pending promise
    // so the UI doesn't hang forever.
    for (const [id, slot] of pending) {
      slot.reject(new SearchError(`Worker error: ${e.message}`, 500));
      pending.delete(id);
    }
  };
  return workerSingleton;
}


function kindToStatus(kind: string): number {
  switch (kind) {
    case 'unsupported': return 501;
    case 'network':     return 502;
    case 'decode':      return 422;
    case 'storage':     return 507;
    case 'aborted':     return 499;
    default:            return 500;
  }
}


/** Helper: post a request to the worker, return a promise that
 *  resolves with the matching reply. `request` is typed loosely
 *  because TypeScript's `Omit<DiscriminatedUnion, 'id'>` collapses
 *  variants — the type-safe surface is at the public functions below
 *  that build the request literal directly. */
function rpc<T>(
  request: { cmd: string; [k: string]: unknown },
  onProgress?: (p: ProgressUpdate) => void,
): Promise<T> {
  const worker = ensureWorker();
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (d: unknown) => void, reject, onProgress });
    worker.postMessage({ ...request, id });
  });
}


// ─── Public API ──────────────────────────────────────────────────────────


/** Returns true if the corpus is already installed in OPFS. */
export function corpusExistsInOpfs(filename: string): Promise<boolean> {
  return rpc<boolean>({ cmd: 'has', filename });
}


/** Download + decompress the corpus into OPFS. `onProgress` fires
 *  multiple times during the download and once with `phase:'done'`. */
export function installCorpus(
  url: string,
  filename: string,
  onProgress?: (p: ProgressUpdate) => void,
): Promise<void> {
  return rpc<void>({ cmd: 'install', url, filename }, onProgress);
}


/** Decompress a corpus archive the user picked from disk into OPFS.
 *  Same destination and progress reporting as `installCorpus`, just
 *  sourced from a local file instead of the network — so it works with
 *  no connectivity at all (file shared over WhatsApp, a USB stick…). */
export function installCorpusFromFile(
  file: File,
  filename: string,
  onProgress?: (p: ProgressUpdate) => void,
): Promise<void> {
  return rpc<void>({ cmd: 'install-file', file, filename }, onProgress);
}


/** Decide what state the offline DB is in for this user. Cheap call —
 *  use it on app open to decide whether to render the download screen
 *  or jump straight into search. */
export async function openOfflineEngine(filename: string): Promise<OfflineState> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    return { kind: 'unsupported', reason: 'OPFS not available in this browser.' };
  }
  if (typeof Worker === 'undefined') {
    return { kind: 'unsupported', reason: 'Web Workers not available.' };
  }
  try {
    const exists = await corpusExistsInOpfs(filename);
    if (!exists) return { kind: 'needs-download' };
    await rpc<void>({ cmd: 'open', filename });
    const engine: OfflineEngine = {
      search:    (opts) => rpc<SearchResponse>({ cmd: 'search', opts: opts as unknown as Record<string, unknown> }),
      discourse: (opts) => rpc<DiscourseResponse>({ cmd: 'discourse', opts: opts as unknown as Record<string, unknown> }),
      catalog:   () => rpc<CatalogResponse>({ cmd: 'catalog' }),
      languages: () => rpc<LanguagesResponse>({ cmd: 'languages' }),
      dateRange: () => rpc<DateRangeResponse>({ cmd: 'date-range' }),
      close:     () => rpc<void>({ cmd: 'close' }),
    };
    return { kind: 'ready', engine };
  } catch (e) {
    const kind = (e as unknown as { kind?: string }).kind;
    if (kind === 'unsupported') {
      return { kind: 'unsupported', reason: (e as Error).message };
    }
    throw e;
  }
}
