'use client';

/**
 * First-launch gate for the Electron desktop app.
 *
 * The desktop app ships the corpus bundled inside the installer; on
 * first launch OfflineProvider fetches it from the app's local server
 * and installs it (a few minutes). This gate shows a "Setting up…"
 * screen until the local engine is ready, then reveals the app. Every
 * later launch finds the corpus already in OPFS and flashes past.
 *
 * Gated on `window.oshoDesktop` — on the plain website this component
 * is a pure pass-through, so the site is unaffected.
 */
import { useEffect, useState } from 'react';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { useOfflineStatus } from '../lib/search/OfflineProvider';


function fmtMb(bytes: number): string {
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(1)} GB`;
  return `${mb.toFixed(0)} MB`;
}


export function DesktopGate({ children }: { children: React.ReactNode }) {
  const { state, progress } = useOfflineStatus();
  // Render children on the first client paint so the markup matches the
  // prerendered HTML (no hydration mismatch); the gate engages on mount.
  const [mounted, setMounted] = useState(false);
  useEffect(() => { setMounted(true); }, []);

  const isDesktop = mounted
    && typeof window !== 'undefined'
    && !!(window as { oshoDesktop?: unknown }).oshoDesktop;

  // Not the desktop app, or the engine is ready → render the app.
  if (!isDesktop || state.kind === 'ready') return <>{children}</>;

  if (state.kind === 'failed' || state.kind === 'unsupported') {
    return (
      <Shell>
        <AlertTriangle size={26} className="text-amber-400" />
        <h1 className="text-lg font-medium">Couldn&apos;t set up the archive</h1>
        <p className="text-xs opacity-50 max-w-sm break-words">{state.reason}</p>
        <p className="text-sm opacity-70 max-w-sm mt-1">
          Please reopen the app. If this keeps happening, reinstall it.
        </p>
      </Shell>
    );
  }

  if (state.kind === 'downloading') {
    const received = progress?.bytesReceived ?? 0;
    const total = progress?.bytesTotal ?? 0;
    const pct = total > 0 ? Math.min(100, Math.round((received / total) * 100)) : null;
    const unpacking = progress?.phase === 'writing' || progress?.phase === 'done';
    return (
      <Shell>
        <Loader2 size={26} className="text-gold animate-spin" />
        <h1 className="text-lg font-medium">Setting up your offline archive</h1>
        <p className="text-sm opacity-70 max-w-sm">
          A one-time setup — the complete archive is being unpacked onto
          this device. After this the app opens instantly and works with
          no internet.
        </p>
        <div className="w-full max-w-sm mt-1">
          <div className="h-1.5 rounded-full bg-gold/15 overflow-hidden">
            <div
              className="h-full bg-gold transition-[width] duration-300 ease-out"
              style={{ width: pct !== null && !unpacking ? `${pct}%` : '100%' }}
            />
          </div>
          <div className="mt-2 text-xs opacity-60 tabular-nums">
            {unpacking
              ? 'Unpacking — almost done…'
              : pct !== null
                ? `${fmtMb(received)} / ${fmtMb(total)}`
                : 'Preparing…'}
          </div>
        </div>
      </Shell>
    );
  }

  // 'unknown' / 'needs-download' — the brief probe window. A bare
  // spinner, so a returning user (corpus already installed) doesn't see
  // a flash of "setting up" copy.
  return (
    <Shell>
      <Loader2 size={26} className="text-gold animate-spin" />
    </Shell>
  );
}


function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-3 px-8 text-center bg-[rgb(var(--bg))] text-[rgb(var(--fg))]">
      <div className="mb-3 text-xs uppercase tracking-[0.35em] text-gold/80">
        Osho Archives
      </div>
      {children}
    </div>
  );
}
