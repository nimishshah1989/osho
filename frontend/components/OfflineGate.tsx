'use client';

/**
 * First-run gate for the offline-only PWA build.
 *
 * The offline-only build (Cloudflare Pages, `NEXT_PUBLIC_OFFLINE_ONLY=
 * true`) ships no `/api/*` proxy routes — there is no network backend
 * to fall back to. So while the corpus is downloading on first launch
 * the app genuinely has no data source, and letting the search /
 * archive / read pages render would just show a wall of fetch errors.
 *
 * This component blocks the app shell behind a branded setup screen
 * until the local engine is ready:
 *
 *   downloading / unknown → progress screen
 *   failed                → error + Retry
 *   unsupported           → browser-requirements screen
 *   ready                 → render children (the real app)
 *
 * After the first successful download the corpus lives in OPFS, the
 * engine opens in well under a second on every subsequent launch, and
 * this gate flashes past invisibly.
 *
 * On the Vercel build (`NEXT_PUBLIC_OFFLINE_ONLY` unset) the gate is a
 * pure pass-through — the API proxy covers the download window, and
 * `OfflineBanner` carries the messaging.
 */
import { Loader2, CloudOff, RefreshCw } from 'lucide-react';
import { useOfflineStatus } from '../lib/search/OfflineProvider';
import { useLocale } from '../lib/i18n';

const OFFLINE_ONLY = process.env.NEXT_PUBLIC_OFFLINE_ONLY === 'true';


export function OfflineGate({ children }: { children: React.ReactNode }) {
  const { state, progress, startDownload } = useOfflineStatus();
  const { t } = useLocale();

  // Vercel build, or engine already ready → app renders normally.
  if (!OFFLINE_ONLY || state.kind === 'ready') return <>{children}</>;

  if (state.kind === 'unsupported') {
    return (
      <Shell>
        <CloudOff size={28} className="text-amber-400" />
        <h1 className="text-lg font-medium">{t('offline.unsupported.title')}</h1>
        <p className="text-sm opacity-70 max-w-sm">{t('offline.unsupported.note')}</p>
      </Shell>
    );
  }

  if (state.kind === 'failed') {
    return (
      <Shell>
        <CloudOff size={28} className="text-amber-400" />
        <h1 className="text-lg font-medium">{t('offline.failed.title')}</h1>
        <p className="text-sm opacity-70 max-w-sm">{t('offline.failed.note')}</p>
        <p className="text-xs opacity-50 max-w-sm break-words">{state.reason}</p>
        <button
          type="button"
          onClick={() => startDownload()}
          className="mt-2 inline-flex items-center gap-2 rounded-full bg-gold/15 px-5 py-2 text-sm text-gold hover:bg-gold/25 transition-colors"
        >
          <RefreshCw size={14} /> {t('offline.failed.retry')}
        </button>
      </Shell>
    );
  }

  // 'unknown' — the brief OPFS probe on every launch (corpus already
  // installed or not). Show just a spinner so a returning user doesn't
  // get a flash of "downloading…" copy for a download that isn't
  // happening.
  if (state.kind === 'unknown') {
    return (
      <Shell>
        <Loader2 size={28} className="text-gold animate-spin" />
      </Shell>
    );
  }

  // 'downloading' — first-run progress screen.
  // `bytesReceived / bytesTotal` is the compressed-download fraction —
  // an accurate, monotonic bar. `bytesWritten` is the decompressed
  // size and is only shown as a "landed on device" figure.
  const received = progress?.bytesReceived ?? 0;
  const total = progress?.bytesTotal ?? 0;
  const opening = progress?.phase === 'done';
  const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;

  return (
    <Shell>
      <Loader2 size={28} className="text-gold animate-spin" />
      <h1 className="text-lg font-medium">{t('offline.setup.title')}</h1>
      <p className="text-sm opacity-70 max-w-sm">{t('offline.setup.subtitle')}</p>

      <div className="w-full max-w-sm mt-1">
        <div className="h-1.5 rounded-full bg-gold/15 overflow-hidden">
          <div
            className="h-full bg-gold transition-[width] duration-300 ease-out"
            style={{ width: pct !== null ? `${pct}%` : '8%' }}
          />
        </div>
        <div className="mt-2 flex items-center justify-between text-xs tabular-nums opacity-60">
          <span>
            {opening
              ? t('offline.setup.opening')
              : pct !== null
                ? `${fmtMb(received)} / ${fmtMb(total)}`
                : t('offline.setup.preparing')}
          </span>
          {pct !== null && !opening && <span>{pct}%</span>}
        </div>
      </div>

      <p className="text-xs opacity-50 max-w-sm mt-1">{t('offline.setup.note')}</p>
    </Shell>
  );
}


function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 px-6 text-center bg-[rgb(var(--bg))] text-[rgb(var(--fg))]">
      <div className="mb-3 text-xs uppercase tracking-[0.35em] text-gold/80">
        Osho Archives
      </div>
      {children}
    </div>
  );
}


function fmtMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(0)} MB`;
}
