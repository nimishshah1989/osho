// Static-export bits are gated behind the `STATIC_EXPORT` env var so
// the Vercel build keeps its serverless /api/* routes intact. The
// Cloudflare Pages build sets `STATIC_EXPORT=true` via `npm run
// build:static`; nothing else does.
//
// Vercel honours `output: 'export'` if it's set (cubic was right —
// it doesn't silently ignore it), which would drop the API proxy
// routes and break the production fallback path. So we leave the
// option unset for normal builds.
const STATIC_EXPORT = process.env.STATIC_EXPORT === 'true';

/** @type {import('next').NextConfig} */
const nextConfig = {
  ...(STATIC_EXPORT ? {
    // Produces a fully-prerendered tree in `out/` for any static
    // host (Cloudflare Pages, Netlify, S3 + CloudFront, plain nginx).
    output: 'export',
    // Cloudflare Pages serves `/foo` and `/foo/` interchangeably and
    // expects `/foo/index.html` in the output.
    trailingSlash: true,
  } : {}),

  // Next/Image needs the Node-side loader; with static export we
  // either disable optimisation or use a custom remote loader. The
  // app doesn't actually use Next/Image so this is harmless on
  // Vercel and required on static.
  images: { unoptimized: true },
};

export default nextConfig;
