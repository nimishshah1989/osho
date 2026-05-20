/**
 * Dedicated Web Worker hosting sqlite-wasm + OPFS for the PWA.
 *
 * Lives in a worker (not the main thread) because:
 *
 *   1. OPFS `createSyncAccessHandle` and sqlite-wasm's `OpfsDb` both
 *      need a dedicated-worker context per spec. Main-thread support
 *      only landed in Chrome 122 / Safari 17.4 and requires
 *      cross-origin isolation (COOP/COEP), which we don't set.
 *
 *   2. Running multi-megabyte FTS queries off the main thread keeps
 *      the UI responsive — typing in the search box never hitches
 *      while a discourse loads.
 *
 * The worker hosts the entire engine (which is sync), so all the work
 * Python's `cloud_api.py` would do happens here. Main thread is a thin
 * RPC client (`./client.ts`) that posts messages and awaits replies.
 *
 * Messages:
 *
 *   request                          → reply
 *   {cmd:'install', url, filename}   → {ok:true} | {ok:false,kind,message}
 *                                      + zero or more {progress:{...}}
 *   {cmd:'install-file', file, filename} → same replies as 'install'
 *   {cmd:'has',     filename}        → {ok:true, exists:boolean}
 *   {cmd:'open',    filename}        → {ok:true} | unsupported
 *   {cmd:'search',  opts}            → {ok:true, data:SearchResponse}
 *   {cmd:'discourse', opts}          → {ok:true, data:DiscourseResponse}
 *   {cmd:'close'}                    → {ok:true}
 *
 * Every reply (success or failure) carries the `id` of the request so
 * the client can resolve / reject the right promise.
 */
import { Decompress } from 'fzstd';
import sqlite3InitModule from '@sqlite.org/sqlite-wasm';
import {
  catalog, dateRange, discourse, languages, search,
} from '../engine';
import type {
  CatalogResponse, DateRangeResponse, DiscourseOptions, LanguagesResponse,
} from '../engine';
import type { Database, DiscourseResponse, SearchOptions, SearchResponse } from '../types';


// ─── Reply / request shapes ──────────────────────────────────────────────


export type ProgressUpdate = {
  phase: 'downloading' | 'writing' | 'done';
  bytesReceived: number;
  bytesTotal: number | null;
  bytesWritten: number;
};

export type WorkerRequest =
  | { id: number; cmd: 'install'; url: string; filename: string }
  | { id: number; cmd: 'install-file'; file: Blob; filename: string }
  | { id: number; cmd: 'has'; filename: string }
  | { id: number; cmd: 'open'; filename: string }
  | { id: number; cmd: 'search'; opts: SearchOptions }
  | { id: number; cmd: 'discourse'; opts: DiscourseOptions }
  | { id: number; cmd: 'catalog' }
  | { id: number; cmd: 'languages' }
  | { id: number; cmd: 'date-range' }
  | { id: number; cmd: 'close' };

export type WorkerReply =
  | { id: number; ok: true; data?: unknown }
  | { id: number; ok: false; kind: 'unsupported' | 'network' | 'decode' | 'storage' | 'aborted' | 'engine'; message: string }
  | { id: number; progress: ProgressUpdate };


// ─── Internal state (lives for the worker's lifetime) ───────────────────


type Sqlite3 = Awaited<ReturnType<typeof sqlite3InitModule>>;
type Sqlite3Db = { exec: (opts: unknown) => unknown; close: () => void };

let sqlite3: Sqlite3 | null = null;
let db: Sqlite3Db | null = null;
let dbAdapter: Database | null = null;


async function ensureSqlite(): Promise<Sqlite3> {
  if (sqlite3) return sqlite3;
  sqlite3 = await sqlite3InitModule({
    print: (...args: unknown[]) => console.log('[sqlite]', ...args),
    printErr: (...args: unknown[]) => console.error('[sqlite]', ...args),
  });
  return sqlite3;
}


/** Wrap a sqlite-wasm `OO1` DB in the engine's `Database` interface. */
function makeAdapter(handle: Sqlite3Db): Database {
  return {
    all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
      const cols: string[] = [];
      const rows: unknown[][] = [];
      handle.exec({
        sql,
        bind: params,
        rowMode: 'array',
        columnNames: cols,
        callback: (row: unknown[]) => { rows.push(row); },
      });
      return rows.map((row) => {
        const out: Record<string, unknown> = {};
        for (let i = 0; i < cols.length; i++) out[cols[i]] = row[i];
        return out as T;
      });
    },
    get<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T | undefined {
      return this.all<T>(sql, params)[0];
    },
  };
}


// ─── DB install (download + decompress → OPFS) ──────────────────────────


async function corpusExists(filename: string): Promise<boolean> {
  try {
    const root = await navigator.storage.getDirectory();
    await root.getFileHandle(filename, { create: false });
    return true;
  } catch {
    return false;
  }
}


interface InstallProgressEmit { (p: ProgressUpdate): void }

async function installCorpus(url: string, filename: string, emit: InstallProgressEmit): Promise<void> {
  const response = await fetch(url);
  if (!response.ok) throw makeErr('network', `HTTP ${response.status} fetching ${url}`);
  if (!response.body) throw makeErr('network', 'Response had no body.');
  const bytesTotal = parseInt(response.headers.get('Content-Length') ?? '', 10) || null;
  await streamIntoOpfs(response.body, bytesTotal, filename, emit);
}


async function installCorpusFromFile(
  file: Blob,
  filename: string,
  emit: InstallProgressEmit,
): Promise<void> {
  // The picked file is the same compressed `.zst` archive the URL path
  // downloads — just sourced from the user's disk instead of the
  // network. `file.size` is exact, so progress is precise.
  await streamIntoOpfs(file.stream(), file.size || null, filename, emit);
}


/**
 * Core installer: drain a stream of compressed bytes through fzstd into
 * a `.partial` OPFS file, then atomically swap it in as the corpus.
 * Shared by the URL download and the local-file import — they differ
 * only in where the byte stream is sourced from.
 */
async function streamIntoOpfs(
  stream: ReadableStream<Uint8Array>,
  bytesTotal: number | null,
  filename: string,
  emit: InstallProgressEmit,
): Promise<void> {
  const root = await navigator.storage.getDirectory();
  const tempName = `${filename}.partial`;
  // Drop any leftover .partial from a previous attempt so we start
  // from a clean slate.
  try { await root.removeEntry(tempName); } catch { /* not there, fine */ }

  let bytesReceived = 0;
  let bytesWritten = 0;

  const tempHandle = await root.getFileHandle(tempName, { create: true });
  let sah: FileSystemSyncAccessHandle;
  try {
    sah = await (tempHandle as unknown as {
      createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
    }).createSyncAccessHandle();
  } catch (e) {
    throw makeErr('storage', `OPFS sync-access-handle unavailable: ${(e as Error).message}`);
  }

  // Stream-decompress: feed decoded chunks straight into OPFS. Track the
  // *actual* number of bytes the SAH accepted (short writes are rare
  // but valid per spec) and loop until the whole chunk is written.
  const decoder = new Decompress((chunk) => {
    let offset = 0;
    while (offset < chunk.byteLength) {
      const written = sah.write(
        chunk.subarray(offset),
        { at: bytesWritten + offset },
      );
      if (written <= 0) {
        throw makeErr('storage', `OPFS write returned ${written} — out of space?`);
      }
      offset += written;
    }
    bytesWritten += chunk.byteLength;
  });

  emit({ phase: 'downloading', bytesReceived, bytesTotal, bytesWritten });

  const reader = stream.getReader();
  let lastEmit = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesReceived += value.byteLength;
      try {
        decoder.push(value);
      } catch (e) {
        // The decoder callback writes straight to OPFS, so a thrown
        // error here can be a corrupt-archive failure from fzstd OR
        // an out-of-space failure we threw inside the SAH write loop.
        // Preserve any `__kind` we already set so storage errors don't
        // get mislabeled as decode errors.
        if (isErr(e)) throw e;
        throw makeErr('decode', `Corrupt archive: ${(e as Error).message}`);
      }
      if (bytesReceived - lastEmit > 256 * 1024) {
        emit({ phase: 'downloading', bytesReceived, bytesTotal, bytesWritten });
        lastEmit = bytesReceived;
      }
    }
    // Final flush — wrap separately so a corrupt tail-block doesn't get
    // reported as a network error.
    try {
      decoder.push(new Uint8Array(0), true);
    } catch (e) {
      throw makeErr('decode', `Corrupt archive at end: ${(e as Error).message}`);
    }
    emit({ phase: 'writing', bytesReceived, bytesTotal, bytesWritten });
  } catch (e) {
    sah.close();
    try { await root.removeEntry(tempName); } catch { /* ignore */ }
    throw isErr(e) ? e : makeErr('network', `Stream error: ${(e as Error).message}`);
  }

  sah.flush();
  sah.close();

  // Install the new corpus. We keep the old file around until we've
  // confirmed the new one is in place — if the move fails halfway, the
  // user is left with a working old DB rather than no DB at all.
  const moveSupported = typeof (tempHandle as unknown as {
    move?: (n: string) => Promise<void>;
  }).move === 'function';
  const backupName = `${filename}.backup`;
  // Move the existing corpus aside (if any), then put the new one in
  // place, then delete the backup on success. On any failure restore
  // the backup.
  const hadExisting = await corpusExists(filename);
  if (hadExisting) {
    if (moveSupported) {
      const existing = await root.getFileHandle(filename);
      await (existing as unknown as { move: (n: string) => Promise<void> }).move(backupName);
    } else {
      await copyOpfsFile(root, filename, backupName);
      await root.removeEntry(filename);
    }
  }
  try {
    if (moveSupported) {
      await (tempHandle as unknown as { move: (n: string) => Promise<void> }).move(filename);
    } else {
      await copyOpfsFile(root, tempName, filename);
      await root.removeEntry(tempName);
    }
  } catch (e) {
    if (hadExisting) {
      // Roll back: move the backup back into place.
      try {
        const backup = await root.getFileHandle(backupName);
        if (moveSupported) {
          await (backup as unknown as { move: (n: string) => Promise<void> }).move(filename);
        } else {
          await copyOpfsFile(root, backupName, filename);
          await root.removeEntry(backupName);
        }
      } catch { /* user has lost the file — surface the original error */ }
    }
    throw makeErr('storage', `Install failed: ${(e as Error).message}`);
  }
  if (hadExisting) {
    try { await root.removeEntry(backupName); } catch { /* harmless */ }
  }

  emit({ phase: 'done', bytesReceived, bytesTotal, bytesWritten });
}


async function copyOpfsFile(
  root: FileSystemDirectoryHandle,
  fromName: string,
  toName: string,
): Promise<void> {
  const fromHandle = await root.getFileHandle(fromName);
  const toHandle = await root.getFileHandle(toName, { create: true });
  const fromFile = await fromHandle.getFile();
  const reader = fromFile.stream().getReader();
  const writer = await (toHandle as unknown as {
    createWritable(): Promise<FileSystemWritableFileStream>;
  }).createWritable();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      await writer.write(value);
    }
  } finally {
    await writer.close();
  }
}


// ─── Open / search / discourse ──────────────────────────────────────────


async function openDb(filename: string): Promise<void> {
  const sq = await ensureSqlite();
  if (!sq.oo1?.OpfsDb) {
    throw makeErr('unsupported', 'sqlite-wasm built without OPFS support.');
  }
  // Close any previously-open handle first — repeated `open` calls
  // (e.g. after the user re-installs the corpus) would otherwise leak
  // an OPFS file lock and the new open would fail with SQLITE_BUSY.
  closeDb();
  try {
    // Flags: 'c' = create-if-missing. We deliberately drop the 't' the
    // first cut had — that flag enables SQL trace logging on every
    // statement, which we don't want in a production worker.
    db = new sq.oo1.OpfsDb(`/${filename}`, 'c') as Sqlite3Db;
  } catch (e) {
    throw makeErr('storage', `Could not open OPFS DB: ${(e as Error).message}`);
  }
  dbAdapter = makeAdapter(db);
}


function requireDb(): Database {
  if (!dbAdapter) throw makeErr('engine', 'Database not opened — call open() first.');
  return dbAdapter;
}


function runSearch(opts: SearchOptions): SearchResponse {
  const eng = requireDb();
  try {
    return search(eng, opts);
  } catch (e) {
    throw makeErr('engine', (e as Error).message);
  }
}


function runDiscourse(opts: DiscourseOptions): DiscourseResponse {
  const eng = requireDb();
  try {
    return discourse(eng, opts);
  } catch (e) {
    throw makeErr('engine', (e as Error).message);
  }
}


function closeDb(): void {
  if (db) try { db.close(); } catch { /* ignore */ }
  db = null;
  dbAdapter = null;
}


// ─── Dispatcher ─────────────────────────────────────────────────────────


type ErrKind = 'unsupported' | 'network' | 'decode' | 'storage' | 'aborted' | 'engine';

interface InternalError extends Error {
  __kind: ErrKind;
}
function makeErr(kind: ErrKind, message: string): InternalError {
  const e = new Error(message) as InternalError;
  e.__kind = kind;
  return e;
}
function isErr(e: unknown): e is InternalError {
  return !!e && typeof e === 'object' && '__kind' in (e as object);
}


function reply(msg: WorkerReply): void {
  (self as unknown as { postMessage: (m: unknown) => void }).postMessage(msg);
}


async function handle(req: WorkerRequest): Promise<void> {
  try {
    switch (req.cmd) {
      case 'has':
        reply({ id: req.id, ok: true, data: await corpusExists(req.filename) });
        return;
      case 'install':
        await installCorpus(req.url, req.filename, (p) => reply({ id: req.id, progress: p }));
        reply({ id: req.id, ok: true });
        return;
      case 'install-file':
        await installCorpusFromFile(req.file, req.filename, (p) => reply({ id: req.id, progress: p }));
        reply({ id: req.id, ok: true });
        return;
      case 'open':
        await openDb(req.filename);
        reply({ id: req.id, ok: true });
        return;
      case 'search':
        reply({ id: req.id, ok: true, data: runSearch(req.opts) });
        return;
      case 'discourse':
        reply({ id: req.id, ok: true, data: runDiscourse(req.opts) });
        return;
      case 'catalog':
        reply({ id: req.id, ok: true, data: catalog(requireDb()) });
        return;
      case 'languages':
        reply({ id: req.id, ok: true, data: languages(requireDb()) });
        return;
      case 'date-range':
        reply({ id: req.id, ok: true, data: dateRange(requireDb()) });
        return;
      case 'close':
        closeDb();
        reply({ id: req.id, ok: true });
        return;
    }
  } catch (e) {
    const kind = isErr(e) ? e.__kind : 'engine';
    const message = e instanceof Error ? e.message : String(e);
    reply({ id: req.id, ok: false, kind, message });
  }
}


self.addEventListener('message', (e: MessageEvent<WorkerRequest>) => { void handle(e.data); });


// ─── Worker-only type shim for OPFS sync handles ────────────────────────

interface FileSystemSyncAccessHandle {
  read(buffer: ArrayBufferView, opts?: { at?: number }): number;
  write(buffer: ArrayBufferView, opts?: { at?: number }): number;
  flush(): void;
  close(): void;
  getSize(): number;
  truncate(size: number): void;
}

// Force module status so `self` is the DedicatedWorkerGlobalScope and
// not the SharedWorker scope.
export {};
