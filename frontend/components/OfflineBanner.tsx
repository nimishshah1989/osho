'use client';

/**
 * Top-of-page banner that shows what the offline subsystem is doing.
 *
 *   needs-download — "Read offline?" with a Load-from-file button
 *   downloading    — install progress ("142 / 552 MB · 26%")
 *   failed         — error + Load-from-file (re-pick to retry)
 *   ready          — small "offline" badge so the user knows their next
 *                    query won't need the network
 *   unsupported    — nothing (silently fall back to API)
 *
 * The corpus is installed from a file the user picked off disk — the
 * compressed `osho.db.zst` or an already-extracted `osho.db`. There is
 * no network download path. Dismissable per-tab (sessionStorage).
 */
import { useRef, useState, type ChangeEvent } from 'react';
import { Cloud, CloudOff, FolderOpen, Loader2, X } from 'lucide-react';
import { useOfflineStatus } from '../lib/search/OfflineProvider';


const DISMISS_KEY = 'osho:offline-banner-dismissed';


export function OfflineBanner() {
  const { state, progress, installFromFile } = useOfflineStatus();
  const fileInputRef = useRef<HTMLInputElement>(null);
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
  if (dismissed) return null;

  const dismiss = () => {
    setDismissed(true);
    try { sessionStorage.setItem(DISMISS_KEY, '1'); } catch { /* noop */ }
  };

  const pickFile = () => fileInputRef.current?.click();
  const onFilePicked = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    // Clear the value so picking the same file again still fires change.
    e.target.value = '';
    if (file) installFromFile(file);
  };

  // Hidden picker. Deliberately no `accept` filter: mobile pickers grey
  // out files whose extension they don't recognise (`.zst` is often
  // unknown), which would make the corpus unselectable on a phone. The
  // worker validates the pick by inspecting its magic bytes.
  const filePicker = (
    <input
      ref={fileInputRef}
      type="file"
      onChange={onFilePicked}
      style={{ display: 'none' }}
    />
  );

  const loadButton = (
    <button
      type="button"
      onClick={pickFile}
      className="inline-flex items-center gap-1 text-gold hover:underline"
    >
      <FolderOpen size={12} /> Load from file
    </button>
  );

  const dismissBtn = (
    <button
      type="button"
      onClick={dismiss}
      className="text-stone-400 dark:text-ivory/50 hover:text-[rgb(var(--fg))]"
      aria-label="Dismiss"
    >
      <X size={14} />
    </button>
  );

  if (state.kind === 'needs-download') {
    return (
      <BannerShell colour="text-gold">
        {filePicker}
        <Cloud size={14} />
        <span>Read offline?</span>
        {loadButton}
        <span className="ml-auto">{dismissBtn}</span>
      </BannerShell>
    );
  }

  if (state.kind === 'downloading') {
    // Show the actual transfer: bytes read from the file / total size.
    // Accurate — unlike the decompressed size, which isn't known until
    // the stream ends.
    const received = progress?.bytesReceived ?? 0;
    const total = progress?.bytesTotal ?? 0;
    const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
    const finishing = progress?.phase === 'writing' || progress?.phase === 'done';
    return (
      <BannerShell colour="text-gold">
        <Loader2 size={14} className="animate-spin" />
        <span>
          {finishing ? 'Unpacking offline archive' : 'Installing offline archive'}
          {progress && !finishing && (
            <span className="opacity-70 ml-2 tabular-nums">
              {fmtMb(received)}
              {total > 0 && ` / ${fmtMb(total)}`}
              {pct !== null && ` · ${pct}%`}
            </span>
          )}
        </span>
        <button
          type="button"
          onClick={dismiss}
          className="ml-auto text-stone-400 dark:text-ivory/50 hover:text-[rgb(var(--fg))]"
          aria-label="Hide banner (install continues)"
        >
          <X size={14} />
        </button>
      </BannerShell>
    );
  }

  if (state.kind === 'failed') {
    return (
      <BannerShell colour="text-amber-400">
        {filePicker}
        <CloudOff size={14} />
        <span>Couldn&apos;t set up offline use.</span>
        <span className="opacity-70 ml-2 truncate">{state.reason}</span>
        <span className="ml-auto">{loadButton}</span>
        {dismissBtn}
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
