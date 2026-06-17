'use client';

/**
 * App-level React provider that owns the offline-engine lifecycle.
 *
 * Responsibilities:
 *   1. On mount, ask the worker whether the corpus is already in OPFS.
 *   2. If yes → open it and expose the engine. Subsequent calls to
 *      `useOfflineEngine()` return it; `searchApi(...)` will route
 *      every query through the local DB.
 *   3. If no → state is `needs-download`. The user installs the corpus
 *      via `installFromFile()` — a corpus file they already have on
 *      disk (bundled with the desktop app, shared over
 *      WhatsApp, a USB stick…). There is deliberately NO network
 *      download path; until the corpus is loaded the UI works against
 *      the API.
 *   4. If the browser doesn't support OPFS / workers → stay
 *      unsupported forever. UI sticks to the API. No banner shown,
 *      no spam.
 */
import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
} from 'react';
import {
  installCorpusFromFile, openOfflineEngine,
} from './worker/client';
import type {
  OfflineEngine, OfflineState, ProgressUpdate,
} from './worker/client';


// ─── Context shape ───────────────────────────────────────────────────────


export interface OfflineContextValue {
  /** The current state of the offline subsystem. UI flips behaviour
   *  off this. */
  state: OfflineRuntimeState;
  /** The ready engine, or null when not yet available. `searchApi`
   *  takes this directly. */
  engine: OfflineEngine | null;
  /** Most recent install-progress event, while an install is active. */
  progress: ProgressUpdate | null;
  /** Install the corpus from a file the user picked off disk — the
   *  compressed `.zst` archive or an already-extracted `.db`. */
  installFromFile: (file: Blob) => void;
}


export type OfflineRuntimeState =
  | { kind: 'unknown' }            // before the first probe
  | { kind: 'needs-download' }     // no corpus yet — awaiting the user
  | { kind: 'downloading' }        // corpus install in progress
  | { kind: 'ready' }              // engine available
  | { kind: 'unsupported'; reason: string }
  | { kind: 'failed';     reason: string };  // install or open failed


// Tunables ---------------------------------------------------------------

const OPFS_FILENAME = 'osho.db';

// The Electron desktop app's preload script sets `window.oshoDesktop`
// with the local URL of the corpus bundled inside the installer. On the
// plain website this is undefined.
type DesktopWindow = Window & { oshoDesktop?: { corpusUrl?: string } };


const Ctx = createContext<OfflineContextValue>({
  state: { kind: 'unknown' },
  engine: null,
  progress: null,
  installFromFile: () => {},
});


export function OfflineProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<OfflineRuntimeState>({ kind: 'unknown' });
  const [engine, setEngine] = useState<OfflineEngine | null>(null);
  const [progress, setProgress] = useState<ProgressUpdate | null>(null);

  // Track in-flight downloads so we don't kick off duplicates if the
  // provider re-mounts (e.g. fast refresh during dev).
  const downloadingRef = useRef(false);

  // After download or first probe, attempt to open the engine.
  const tryOpen = useCallback(async () => {
    const result: OfflineState = await openOfflineEngine(OPFS_FILENAME);
    if (result.kind === 'ready') {
      setEngine(result.engine);
      setState({ kind: 'ready' });
    } else if (result.kind === 'unsupported') {
      setState({ kind: 'unsupported', reason: result.reason });
    } else {
      // `needs-download` here means we tried to open just after a
      // supposedly-successful install but the file still isn't visible
      // in OPFS — treat as a real failure so the UI surfaces the
      // Retry button. Silently dropping back to 'unknown' would hide
      // the recovery path and leave offline setup stuck forever.
      setState({
        kind: 'failed',
        reason: 'Corpus not present in OPFS after install — try again.',
      });
    }
  }, []);

  // Install the corpus from a `Blob` — a file the user picked off disk
  // (the compressed `.zst` or an already-extracted `.db`), or the
  // bundled corpus the desktop app fetches from its local server. The
  // worker auto-detects the format.
  const installBlob = useCallback(async (file: Blob) => {
    if (downloadingRef.current) return;
    downloadingRef.current = true;
    setState({ kind: 'downloading' });
    setProgress(null);
    try {
      await installCorpusFromFile(file, OPFS_FILENAME, (p) => setProgress(p));
      await tryOpen();
    } catch (e) {
      setState({ kind: 'failed', reason: e instanceof Error ? e.message : String(e) });
    } finally {
      downloadingRef.current = false;
    }
  }, [tryOpen]);

  // Desktop app only: fetch the corpus bundled inside the installer
  // (served by the app's local HTTP server) and install it.
  const installFromUrl = useCallback(async (url: string) => {
    try {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`Bundled corpus unavailable (HTTP ${resp.status}).`);
      await installBlob(await resp.blob());
    } catch (e) {
      setState({ kind: 'failed', reason: e instanceof Error ? e.message : String(e) });
    }
  }, [installBlob]);

  useEffect(() => {
    let cancelled = false;
    async function probe() {
      if (typeof window === 'undefined') return;
      const result = await openOfflineEngine(OPFS_FILENAME);
      if (cancelled) return;
      if (result.kind === 'ready') {
        setEngine(result.engine);
        setState({ kind: 'ready' });
      } else if (result.kind === 'needs-download') {
        // In the desktop app the corpus is bundled in the installer and
        // served by the local server — install it automatically. On the
        // web there's no bundled corpus, so wait for the user to supply
        // one via installFromFile().
        const corpusUrl = (window as DesktopWindow).oshoDesktop?.corpusUrl;
        if (corpusUrl) {
          void installFromUrl(corpusUrl);
        } else {
          setState({ kind: 'needs-download' });
        }
      } else {
        setState({ kind: 'unsupported', reason: result.reason });
      }
    }
    void probe();
    return () => { cancelled = true; };
  }, [installFromUrl]);

  return (
    <Ctx.Provider value={{ state, engine, progress, installFromFile: installBlob }}>
      {children}
    </Ctx.Provider>
  );
}


/** Hook for components that need the offline engine.
 *  Returns null until the engine is ready; pages use this null-or-engine
 *  reference directly when calling `searchApi(opts, engine)`. */
export function useOfflineEngine(): OfflineEngine | null {
  return useContext(Ctx).engine;
}


/** Hook for the install/download banner UI. */
export function useOfflineStatus(): OfflineContextValue {
  return useContext(Ctx);
}
