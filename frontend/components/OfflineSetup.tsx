'use client';

/**
 * Interactive setup body for the /downloadapp page.
 *
 * Lets the user download the archive file and load it into offline
 * storage on one screen, then jump straight into the app — no hunting
 * for a button inside the app afterwards. Uses the same OfflineProvider
 * context as the rest of the app, so a file loaded here is immediately
 * available everywhere.
 */
import { useRef, type ChangeEvent } from 'react';
import Link from 'next/link';
import { Check, Download, FolderOpen, Loader2 } from 'lucide-react';
import { useOfflineStatus } from '../lib/search/OfflineProvider';

const DOWNLOAD_URL = process.env.NEXT_PUBLIC_CORPUS_DOWNLOAD_URL ?? '';

const BTN =
  'inline-flex items-center gap-2 rounded-full bg-gold/15 text-gold '
  + 'px-6 py-3 text-[13px] tracking-[0.08em] uppercase hover:bg-gold/25 '
  + 'transition-colors';


export function OfflineSetup() {
  const { state, progress, installFromFile } = useOfflineStatus();
  const fileRef = useRef<HTMLInputElement>(null);

  const onPick = (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = ''; // allow re-picking the same file
    if (f) installFromFile(f);
  };

  // ── Already installed ───────────────────────────────────────────────
  if (state.kind === 'ready') {
    return (
      <div className="rounded-2xl border border-gold/20 bg-gold/[0.04] px-6 py-7">
        <div className="flex items-center gap-2 text-gold">
          <Check size={18} />
          <span className="text-[15px]">The archive is on this device.</span>
        </div>
        <p className="text-[14px] text-stone-500 dark:text-ivory/60 mt-2 mb-6">
          You can search every discourse now — with or without internet.
        </p>
        <Link href="/" className={BTN}>Open the archive</Link>
      </div>
    );
  }

  // ── Installing right now ────────────────────────────────────────────
  if (state.kind === 'downloading') {
    const received = progress?.bytesReceived ?? 0;
    const total = progress?.bytesTotal ?? 0;
    const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
    const finishing = progress?.phase === 'writing' || progress?.phase === 'done';
    return (
      <div className="rounded-2xl border border-gold/20 bg-gold/[0.04] px-6 py-7">
        <div className="flex items-center gap-2 text-gold">
          <Loader2 size={18} className="animate-spin" />
          <span className="text-[15px]">
            {finishing ? 'Almost done — unpacking…' : 'Setting up your offline archive…'}
          </span>
        </div>
        <div className="mt-4 h-1.5 rounded-full bg-gold/15 overflow-hidden">
          <div
            className="h-full bg-gold transition-[width] duration-300 ease-out"
            style={{ width: pct !== null ? `${pct}%` : '8%' }}
          />
        </div>
        <p className="text-[12px] text-stone-400 dark:text-ivory/40 mt-2 tabular-nums">
          {finishing
            ? 'This step takes a minute or two — please keep this page open.'
            : pct !== null
              ? `${fmtMb(received)} of ${fmtMb(total)}`
              : 'Reading the file…'}
        </p>
      </div>
    );
  }

  // ── Not set up yet — the two steps ──────────────────────────────────
  return (
    <>
      <input ref={fileRef} type="file" onChange={onPick} className="hidden" />

      {state.kind === 'unsupported' && (
        <p className="text-[13px] text-amber-400 leading-relaxed mb-6">
          This browser can&apos;t store the offline archive. Try a recent
          version of Chrome, Edge, Safari, or Firefox.
        </p>
      )}
      {state.kind === 'failed' && (
        <p className="text-[13px] text-amber-400 leading-relaxed mb-6">
          That didn&apos;t work — {state.reason}. Please try choosing the file
          again.
        </p>
      )}

      <Step n={1} title="Download the archive">
        <p className="mb-4">
          One file, about <b className="text-[rgb(var(--fg))]">550&nbsp;MB</b> —
          it saves into your Downloads. Don&apos;t open or unzip it; just let it
          download.
        </p>
        {DOWNLOAD_URL ? (
          <a href={DOWNLOAD_URL} target="_blank" rel="noreferrer" className={BTN}>
            <Download size={15} /> Download the archive
          </a>
        ) : (
          <span className="text-[13px] text-stone-400 dark:text-ivory/40 italic">
            Download link coming soon.
          </span>
        )}
      </Step>

      <Step n={2} title="Add it to the app">
        <p className="mb-4">
          When the download has finished, choose that file here. The app adds
          it to your device — and from then on it works fully offline.
        </p>
        <button type="button" onClick={() => fileRef.current?.click()} className={BTN}>
          <FolderOpen size={15} /> Choose the downloaded file
        </button>
      </Step>
    </>
  );
}


function Step({
  n, title, children,
}: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-8 flex gap-4">
      <div className="flex-shrink-0 w-8 h-8 rounded-full border border-gold/40 text-gold flex items-center justify-center text-[14px]">
        {n}
      </div>
      <div className="flex-1 pt-0.5">
        <h2 className="text-[13px] tracking-[0.15em] uppercase text-gold mb-2">{title}</h2>
        <div className="text-[14px] text-stone-500 dark:text-ivory/60 leading-relaxed">
          {children}
        </div>
      </div>
    </section>
  );
}


function fmtMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
}
