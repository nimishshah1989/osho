'use client';

/**
 * Top-of-page banner that shows what the offline subsystem is doing.
 *
 *   downloading  — "Downloading offline corpus… 24 / 400 MB"
 *   failed       — "Couldn't download. Retry" with a button
 *   ready        — small "offline" badge so the user knows their next
 *                  query won't need the network
 *   unsupported  — nothing (silently fall back to API)
 *
 * The banner is dismissable per-tab (sessionStorage) so a user who
 * doesn't care about offline can hide the progress bar without
 * stopping the download. Their next visit re-shows it if download is
 * still ongoing.
 */
import { useState } from 'react';
import { Cloud, CloudOff, Loader2, RefreshCw, X } from 'lucide-react';
import { useOfflineStatus } from '../lib/search/OfflineProvider';


const DISMISS_KEY = 'osho:offline-banner-dismissed';


export function OfflineBanner() {
  const { state, progress, startDownload } = useOfflineStatus();
  const [dismissed, setDismissed] = useState<boolean>(() => {
    // Wrap the storage read — Safari private mode and some embedded
    // webviews throw SecurityError just by touching sessionStorage,
    // which would otherwise crash the first render.
    if (typeof window === 'undefined') return false;
    try {
      return sessionStorage.getItem(DISMISS_KEY) === '1';
    } catch {
      return false;
    }
  });

  if (state.kind === 'unsupported' || state.kind === 'unknown') return null;
  // Dismiss works for every state. The earlier version excepted
  // 'failed' so a user couldn't hide the failure banner at all — the
  // X button silently no-op'd. Now dismiss is honoured; the Retry
  // button on the failure banner stays the recovery path.
  if (dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* noop */ }
  };

  if (state.kind === 'downloading') {
    const wrote = progress?.bytesWritten ?? 0;
    // Estimate total decompressed size from the compressed size + a
    // conservative 4× ratio. Once we know the actual written total,
    // we'll show the real number.
    const compressed = progress?.bytesTotal ?? 0;
    const estTotal = compressed * 4;
    const pct = estTotal > 0 ? Math.min(99, Math.round((wrote / estTotal) * 100)) : null;
    return (
      <BannerShell colour="text-gold">
        <Loader2 size={14} className="animate-spin" />
        <span>
          Downloading offline corpus
          {progress && (
            <span className="opacity-70 ml-2 tabular-nums">
              {fmtMb(wrote)}
              {estTotal > 0 && ` / ~${fmtMb(estTotal)}`}
              {pct !== null && ` (${pct}%)`}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={dismiss}
          className="ml-auto text-stone-400 dark:text-ivory/50 hover:text-[rgb(var(--fg))]"
          aria-label="Hide download banner (download continues)"
        >
          <X size={14} />
        </button>
      </BannerShell>
    );
  }

  if (state.kind === 'failed') {
    return (
      <BannerShell colour="text-amber-400">
        <CloudOff size={14} />
        <span>Couldn&apos;t download for offline use.</span>
        <span className="opacity-70 ml-2 truncate">{state.reason}</span>
        <button
          type="button"
          onClick={() => startDownload()}
          className="ml-auto inline-flex items-center gap-1 text-gold hover:underline"
        >
          <RefreshCw size={12} /> Retry
        </button>
        <button
          type="button"
          onClick={dismiss}
          className="text-stone-400 dark:text-ivory/50 hover:text-[rgb(var(--fg))]"
          aria-label="Dismiss"
        >
          <X size={14} />
        </button>
      </BannerShell>
    );
  }

  // state.kind === 'ready' — small offline-available badge.
  return (
    <BannerShell colour="text-stone-500 dark:text-ivory/60">
      <Cloud size={12} />
      <span className="opacity-80">Offline ready</span>
      <button
        type="button"
        onClick={dismiss}
        className="ml-auto text-stone-400 dark:text-ivory/40 hover:text-[rgb(var(--fg))]"
        aria-label="Dismiss"
      >
        <X size={12} />
      </button>
    </BannerShell>
  );
}


function BannerShell({ colour, children }: { colour: string; children: React.ReactNode }) {
  return (
    <div className={`fixed top-[3.6rem] md:top-[4.2rem] inset-x-0 z-40 px-3 md:px-8 py-1.5 flex items-center gap-2 text-[11px] tracking-[0.1em] uppercase ${colour} bg-[rgb(var(--bg))]/85 backdrop-blur-md border-b border-gold/15`}>
      {children}
    </div>
  );
}


function fmtMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(0)} MB`;
}
