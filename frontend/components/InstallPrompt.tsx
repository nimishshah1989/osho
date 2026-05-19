'use client';

/**
 * "Install Osho Archives" button. Shows up when the browser fires
 * `beforeinstallprompt` (Chrome desktop, Edge desktop, Android Chrome
 * etc.). On iOS Safari we render a one-line hint instead since iOS
 * doesn't expose a programmatic install prompt — the user has to use
 * Share → Add to Home Screen.
 *
 * The button auto-hides if the app is already running standalone
 * (the user has installed it) — `display-mode: standalone` is true
 * inside an installed PWA.
 */
import { useCallback, useEffect, useState } from 'react';
import { Download } from 'lucide-react';

// Stash the deferred prompt at module scope so re-mounts (navigation
// in the Next app router) don't lose the event.
let deferredPrompt: BeforeInstallPromptEvent | null = null;


type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
};


export function InstallPrompt() {
  const [available, setAvailable] = useState<boolean>(!!deferredPrompt);
  const [installed, setInstalled] = useState<boolean>(false);
  const [iosHint, setIosHint] = useState<boolean>(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const standalone =
      window.matchMedia?.('(display-mode: standalone)').matches
      || (window as unknown as { navigator: { standalone?: boolean } }).navigator?.standalone === true;
    setInstalled(standalone);

    const isIos = /iPad|iPhone|iPod/.test(navigator.userAgent);
    const isSafari = /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
    if (isIos && isSafari && !standalone) setIosHint(true);

    const onPrompt = (e: Event) => {
      // Prevent the browser's auto-mini-infobar so we can place the
      // button where it fits the app's layout.
      e.preventDefault();
      deferredPrompt = e as BeforeInstallPromptEvent;
      setAvailable(true);
    };
    const onInstalled = () => {
      deferredPrompt = null;
      setAvailable(false);
      setInstalled(true);
    };
    window.addEventListener('beforeinstallprompt', onPrompt);
    window.addEventListener('appinstalled', onInstalled);
    return () => {
      window.removeEventListener('beforeinstallprompt', onPrompt);
      window.removeEventListener('appinstalled', onInstalled);
    };
  }, []);

  const handleClick = useCallback(async () => {
    if (!deferredPrompt) return;
    await deferredPrompt.prompt();
    const choice = await deferredPrompt.userChoice;
    if (choice.outcome === 'accepted') {
      // The browser will fire `appinstalled` shortly; the listener
      // above updates state. Clear the deferred prompt now so a
      // re-click doesn't error.
      deferredPrompt = null;
      setAvailable(false);
    }
  }, []);

  if (installed) return null;

  if (available) {
    return (
      <button
        type="button"
        onClick={handleClick}
        className="inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-[12px] tracking-[0.15em] uppercase text-gold border border-gold/40 hover:bg-gold/10 transition-colors font-medium"
        aria-label="Install Osho Archives as an app"
      >
        <Download size={14} />
        Install app
      </button>
    );
  }

  if (iosHint) {
    return (
      <span className="text-[11px] tracking-[0.1em] text-stone-500 dark:text-ivory/60">
        Install: Share → Add to Home Screen
      </span>
    );
  }

  return null;
}
