/**
 * The static export (`output: 'export'`) is used ONLY for the desktop
 * (Electron) build — the desktop app bundles a static copy of the
 * frontend and serves it from a local HTTP server. It is gated behind
 * the `DESKTOP_BUILD` env var so the normal VPS build stays a regular
 * Next.js server build (with the /api proxy routes intact).
 */
const DESKTOP_BUILD = process.env.DESKTOP_BUILD === 'true';

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(DESKTOP_BUILD
    ? {
        output: 'export',
        // Directory-style routes (`/archive/` → `archive/index.html`)
        // so the bundled static tree resolves cleanly.
        trailingSlash: true,
      }
    : {}),
  // Next/Image's optimiser needs a server; the app uses no <Image>, so
  // disabling it is harmless for the VPS build and required for export.
  images: { unoptimized: true },
};

export default nextConfig;
