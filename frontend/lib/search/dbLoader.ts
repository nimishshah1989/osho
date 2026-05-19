/**
 * First-launch downloader for the offline corpus.
 *
 * Fetches `osho.db.zst` (the compressed SQLite corpus) from a CDN,
 * decompresses on the fly, streams the bytes into a file in OPFS.
 * Reports progress so the UI can show a download / decompress meter.
 *
 * Two-tier streaming:
 *   network → fzstd push-decoder → OPFS sync-access-handle
 *
 * Doing it as a stream means we never hold the full ~1.6 GB in memory.
 * The decoder hands us chunks as they arrive; we write them straight
 * to the OPFS handle. Peak RAM is bounded by the chunk size, not the
 * corpus size.
 */
import { Decompress } from 'fzstd';


export interface ProgressEvent {
  /** "downloading" while bytes are coming in from the network;
   *  "writing" while the last few decoded blocks are flushed;
   *  "done" once the file is closed and ready to open. */
  phase: 'downloading' | 'writing' | 'done';
  /** Bytes received from the network so far. */
  bytesReceived: number;
  /** Compressed size of the corpus, if the server reported it. */
  bytesTotal: number | null;
  /** Decompressed bytes written to OPFS so far. Useful for showing
   *  "120 MB / 1.6 GB" rather than the less-meaningful compressed
   *  download progress. */
  bytesWritten: number;
}

export interface LoadOptions {
  /** URL of the compressed SQLite corpus. */
  url: string;
  /** Filename to write inside OPFS. The OPFS adapter opens this same
   *  name from `/<dbFilename>`. */
  opfsFilename: string;
  /** AbortSignal so the UI can cancel a download in progress. */
  signal?: AbortSignal;
  /** Called each time we receive or write a non-trivial chunk. */
  onProgress?: (event: ProgressEvent) => void;
}


export class DbLoadError extends Error {
  constructor(message: string, public readonly kind: 'network' | 'storage' | 'decode' | 'aborted') {
    super(message);
    this.name = 'DbLoadError';
  }
}


/** Returns true when the corpus is already present in OPFS — caller
 *  can skip straight to opening it. */
export async function corpusExistsInOpfs(opfsFilename: string): Promise<boolean> {
  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) return false;
  try {
    const root = await navigator.storage.getDirectory();
    // getFileHandle({ create: false }) throws if the file is missing —
    // that's the cheapest existence check we have without a stat() API.
    await root.getFileHandle(opfsFilename, { create: false });
    return true;
  } catch {
    return false;
  }
}


/** Pull the compressed corpus, decompress, write to OPFS, resolve when
 *  the file is fully written and closed. Throws `DbLoadError` on any
 *  failure path so the UI can render a tidy error state. */
export async function downloadAndInstallCorpus(opts: LoadOptions): Promise<void> {
  const { url, opfsFilename, signal, onProgress } = opts;

  if (typeof navigator === 'undefined' || !navigator.storage?.getDirectory) {
    throw new DbLoadError('OPFS not available in this browser.', 'storage');
  }

  let response: Response;
  try {
    response = await fetch(url, { signal });
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      throw new DbLoadError('Download cancelled.', 'aborted');
    }
    throw new DbLoadError(`Network error: ${(e as Error).message}`, 'network');
  }
  if (!response.ok) {
    throw new DbLoadError(`HTTP ${response.status} fetching ${url}`, 'network');
  }
  if (!response.body) {
    throw new DbLoadError('Response had no body.', 'network');
  }

  const bytesTotal = parseInt(response.headers.get('Content-Length') ?? '', 10) || null;
  let bytesReceived = 0;
  let bytesWritten = 0;

  // Open OPFS file for writing. Use the temp-name + rename pattern so a
  // failed / cancelled download doesn't leave a half-written corpus
  // looking like it's good.
  const root = await navigator.storage.getDirectory();
  const tempName = `${opfsFilename}.partial`;
  // Best-effort: clear any leftover .partial from a previous attempt.
  try { await root.removeEntry(tempName); } catch { /* not there, fine */ }
  const tempHandle = await root.getFileHandle(tempName, { create: true });
  // SAH is the synchronous-write handle the OPFS WASM VFS uses; we use
  // it here for the write path too so we get the fast direct-to-disk
  // throughput rather than the slower async writable-stream path.
  let sah: FileSystemSyncAccessHandle;
  try {
    sah = await (tempHandle as unknown as {
      createSyncAccessHandle(): Promise<FileSystemSyncAccessHandle>;
    }).createSyncAccessHandle();
  } catch (e) {
    throw new DbLoadError(
      `OPFS sync-access-handle unavailable: ${(e as Error).message}`,
      'storage',
    );
  }

  const emit = (phase: ProgressEvent['phase']) => {
    onProgress?.({ phase, bytesReceived, bytesTotal, bytesWritten });
  };

  // Wire up fzstd's push decoder: feed it compressed chunks, it calls
  // our callback with decompressed chunks as they're ready.
  const decoder = new Decompress((chunk) => {
    sah.write(chunk, { at: bytesWritten });
    bytesWritten += chunk.byteLength;
  });

  emit('downloading');

  const reader = response.body.getReader();
  try {
    let lastEmit = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytesReceived += value.byteLength;
      try {
        decoder.push(value);
      } catch (e) {
        throw new DbLoadError(`Corrupt archive: ${(e as Error).message}`, 'decode');
      }
      // Throttle progress emissions to every ~250 KB so we don't
      // spam the UI render loop on a multi-hundred-MB download.
      if (bytesReceived - lastEmit > 256 * 1024) {
        emit('downloading');
        lastEmit = bytesReceived;
      }
    }
    decoder.push(new Uint8Array(0), true); // final flush
    emit('writing');
  } catch (e) {
    sah.close();
    try { await root.removeEntry(tempName); } catch { /* ignore */ }
    if (e instanceof DbLoadError) throw e;
    if ((e as Error).name === 'AbortError') {
      throw new DbLoadError('Download cancelled.', 'aborted');
    }
    throw new DbLoadError(`Stream error: ${(e as Error).message}`, 'network');
  }

  sah.flush();
  sah.close();

  // Atomic-ish rename: drop any old corpus, then rename the .partial in.
  try { await root.removeEntry(opfsFilename); } catch { /* not there, fine */ }
  // OPFS doesn't expose a rename(); the move is implemented via
  // FileSystemFileHandle.move where supported, otherwise via
  // copy-and-delete. Either way the result is the same name.
  const moveSupported = typeof (tempHandle as unknown as {
    move?: (newName: string) => Promise<void>;
  }).move === 'function';
  if (moveSupported) {
    await (tempHandle as unknown as { move: (n: string) => Promise<void> }).move(opfsFilename);
  } else {
    // Fallback: copy bytes into the destination file, then drop the
    // partial. Slow on big files, but only triggered on browsers that
    // don't support FileSystemFileHandle.move.
    await copyOpfsFile(root, tempName, opfsFilename);
    await root.removeEntry(tempName);
  }

  emit('done');
}


// Internal: byte-for-byte copy between two OPFS file handles. Used as
// fallback when the runtime doesn't support `FileSystemFileHandle.move`.
async function copyOpfsFile(
  root: FileSystemDirectoryHandle,
  fromName: string,
  toName: string,
): Promise<void> {
  const fromHandle = await root.getFileHandle(fromName);
  const toHandle = await root.getFileHandle(toName, { create: true });
  const fromFile = await fromHandle.getFile();
  const reader = fromFile.stream().getReader();
  const writer = (await (toHandle as unknown as {
    createWritable(): Promise<FileSystemWritableFileStream>;
  }).createWritable());
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


// ─── TypeScript shims for OPFS types not yet in lib.dom ──────────────────

interface FileSystemSyncAccessHandle {
  read(buffer: ArrayBufferView, opts?: { at?: number }): number;
  write(buffer: ArrayBufferView, opts?: { at?: number }): number;
  flush(): void;
  close(): void;
  getSize(): number;
  truncate(size: number): void;
}
