'use client';

/**
 * App-level React provider that owns the offline-engine lifecycle.
 *
 * Responsibilities:
 *   1. On mount, ask the worker whether the corpus is already in OPFS.
 *   2. If yes → open it and expose the engine. Subsequent calls to
 *      `useOfflineEngine()` return it; `searchApi(...)` will route
 *      every query through the local DB.
 *   3. If no → start downloading in the background. The UI keeps
 *      working against the API proxy while the download happens —
 *      the engine just isn't available yet. When the download
 *      finishes, the engine becomes available and the next search
 *      goes local.
 *   4. If the browser doesn't support OPFS / workers → stay
 *      unsupported forever. UI sticks to the API. No banner shown,
 *      no spam.
 *
 * Configured via `NEXT_PUBLIC_CORPUS_URL`. When unset, the provider
 * stays in "unsupported" (no automatic download attempt) so a local
 * dev environment without a CDN doesn't fail loudly.
 */
import {
  createContext, useCallback, useContext, useEffect, useRef, useState,
} from 'react';
import {
  installCorpus, openOfflineEngine,
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
  /** Most recent download-progress event, when a download is active. */
  progress: ProgressUpdate | null;
  /** Trigger / re-trigger the download. UI rarely needs to call this
   *  manually — it auto-runs on mount when state is needs-download.
   *  Exposed so a "retry" button works after a failure. */
  startDownload: () => void;
}


export type OfflineRuntimeState =
  | { kind: 'unknown' }            // before the first probe
  | { kind: 'downloading' }        // corpus install in progress
  | { kind: 'ready' }              // engine available
  | { kind: 'unsupported'; reason: string }
  | { kind: 'failed';     reason: string };  // download or open failed


// Tunables ---------------------------------------------------------------

const OPFS_FILENAME = 'osho.db';
// User-overridable via env so deploying against the staging CDN
// doesn't need a code change.
const CORPUS_URL = process.env.NEXT_PUBLIC_CORPUS_URL ?? '';


const Ctx = createContext<OfflineContextValue>({
  state: { kind: 'unknown' },
  engine: null,
  progress: null,
  startDownload: () => {},
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
      setState({ kind: 'unknown' });
    }
  }, []);

  const startDownload = useCallback(async () => {
    if (downloadingRef.current) return;
    if (!CORPUS_URL) {
      setState({ kind: 'unsupported', reason: 'No corpus URL configured.' });
      return;
    }
    downloadingRef.current = true;
    setState({ kind: 'downloading' });
    setProgress(null);
    try {
      await installCorpus(CORPUS_URL, OPFS_FILENAME, (p) => setProgress(p));
      await tryOpen();
    } catch (e) {
      setState({ kind: 'failed', reason: e instanceof Error ? e.message : String(e) });
    } finally {
      downloadingRef.current = false;
    }
  }, [tryOpen]);

  useEffect(() => {
    let cancelled = false;
    async function probe() {
      if (typeof window === 'undefined') return;
      // No CDN configured → don't bother trying. The UI silently falls
      // back to the API proxy.
      if (!CORPUS_URL) {
        if (!cancelled) setState({ kind: 'unsupported', reason: 'No corpus URL configured.' });
        return;
      }
      const result = await openOfflineEngine(OPFS_FILENAME);
      if (cancelled) return;
      if (result.kind === 'ready') {
        setEngine(result.engine);
        setState({ kind: 'ready' });
      } else if (result.kind === 'needs-download') {
        // Auto-start the first-launch download. User can dismiss the
        // banner if they don't want offline (handled by the banner
        // component, not here).
        void startDownload();
      } else {
        setState({ kind: 'unsupported', reason: result.reason });
      }
    }
    void probe();
    return () => { cancelled = true; };
  }, [startDownload]);

  return (
    <Ctx.Provider value={{ state, engine, progress, startDownload }}>
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
