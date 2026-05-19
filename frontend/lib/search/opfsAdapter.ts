/**
 * Browser-side `Database` implementation backed by sqlite-wasm + OPFS.
 *
 * Pairs the engine in `./engine.ts` (currently tested against
 * `better-sqlite3` in node) with the same SQLite-3 + FTS5 binary
 * running inside the browser, persisted on disk via the Origin
 * Private File System (OPFS). After first-launch download the user
 * can open the app, kill their Wi-Fi, and every search still works.
 *
 * Why OPFS instead of in-memory: the corpus is ~1.6 GB. Holding it
 * all in WASM heap would (a) require dozens of seconds to load on
 * every cold start and (b) brush against the 4 GB WASM memory cap.
 * OPFS gives sqlite-wasm a real filesystem; only the pages we need
 * for a given query are paged into memory.
 *
 * Platform notes
 *   Chrome / Edge (desktop + Android)  — full OPFS support, fastest path.
 *   Safari 17+ (macOS, iOS, iPadOS)    — OPFS supported.
 *   Safari 16 and below                — no OPFS; we surface a clear
 *                                        error so the caller can fall
 *                                        back to the online API.
 *   WebKitGTK on Linux                 — partial; treated like Safari 16.
 *
 * Worker placement: sqlite-wasm's OPFS VFS requires running in a
 * dedicated Web Worker because OPFS handles are synchronous and would
 * otherwise block the UI thread. We hide the worker behind the
 * promise-returning `Database` interface.
 */
import type { Database } from './types';


/** Caller-facing status from the loader so the UI can show a spinner /
 *  error message. */
export type OpfsStatus =
  | { kind: 'unsupported'; reason: string }
  | { kind: 'ready'; database: Database; close: () => Promise<void> };


/** Open the sqlite3 file at `dbFilename` inside OPFS and return a
 *  `Database` the engine can run against. Caller must have already
 *  written the file (see `./dbLoader.ts`). Returns `unsupported` if
 *  the browser doesn't have OPFS / SAH support so the caller can
 *  gracefully fall back to the FastAPI proxy. */
export async function openOpfsDatabase(dbFilename: string): Promise<OpfsStatus> {
  // OPFS itself is gated behind `navigator.storage.getDirectory`. The
  // synchronous-access-handle (SAH) flavour sqlite-wasm needs is gated
  // behind a worker check; if SAH isn't available, sqlite-wasm refuses
  // to mount the VFS and we land in `unsupported`.
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    return { kind: 'unsupported', reason: 'OPFS not available in this browser.' };
  }

  // Dynamic import — keeps sqlite-wasm out of the initial JS bundle and
  // out of the server-side bundle (the package self-detects node and
  // exports nothing useful there).
  const { default: sqlite3InitModule } = await import('@sqlite.org/sqlite-wasm');

  const sqlite3 = await sqlite3InitModule({
    print: (...args: unknown[]) => console.log('[sqlite]', ...args),
    printErr: (...args: unknown[]) => console.error('[sqlite]', ...args),
  });

  if (!sqlite3.oo1?.OpfsDb) {
    return {
      kind: 'unsupported',
      reason: 'sqlite-wasm built without OPFS support in this environment.',
    };
  }

  let db: { exec: (opts: unknown) => unknown; close: () => void };
  try {
    db = new sqlite3.oo1.OpfsDb(`/${dbFilename}`, 'ct');
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    return { kind: 'unsupported', reason };
  }

  // Adapter around the engine's `Database` interface. sqlite-wasm's
  // `db.exec()` returns column / row arrays; we shape them into
  // record objects so the engine's `r['event_id']`-style access works
  // unchanged.
  const adapter: Database = {
    all<T = Record<string, unknown>>(sql: string, params: unknown[] = []): T[] {
      const cols: string[] = [];
      const rows: unknown[][] = [];
      db.exec({
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
      const rows = this.all<T>(sql, params);
      return rows[0];
    },
  };

  return {
    kind: 'ready',
    database: adapter,
    close: async () => { db.close(); },
  };
}
