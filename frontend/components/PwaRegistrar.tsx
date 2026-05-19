'use client';

/**
 * Two things in one tiny component, mounted once at the layout level:
 *
 *   1. Register the service worker on app load. The browser handles
 *      duplicate registrations gracefully so this is safe to run on
 *      every navigation.
 *
 *   2. Listen for the `beforeinstallprompt` event so we can surface
 *      an "Install" button on browsers that don't auto-prompt (most
 *      desktop Chromiums, some Android variants). The prompt itself
 *      is rendered by the sibling `InstallPrompt` component when
 *      `useInstallPromptAvailable()` returns true.
 */
import { useEffect } from 'react';

export function PwaRegistrar() {
  useEffect(() => {
    if (typeof window === 'undefined') return;
    if (!('serviceWorker' in navigator)) return;
    // Defer registration to `load` so the SW install doesn't compete
    // with first-paint resource fetches.
    const register = () => {
      navigator.serviceWorker
        .register('/sw.js', { scope: '/' })
        .catch((err) => {
          // Non-fatal. Logged for diagnostics; the app still works
          // online without a SW.
          console.warn('[pwa] SW registration failed:', err);
        });
    };
    if (document.readyState === 'complete') register();
    else window.addEventListener('load', register, { once: true });
  }, []);

  return null;
}
