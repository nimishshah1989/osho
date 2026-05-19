/** @type {import('next').NextConfig} */
const nextConfig = {
  // Cloudflare Pages serves static files only — no Node.js server, no
  // /api routes. `output: 'export'` writes a fully-prerendered tree
  // into `out/` so any static host (Cloudflare Pages, Netlify, S3+
  // CloudFront, a plain nginx) can serve it.
  //
  // Vercel deploys are unaffected — they ignore `output: 'export'`
  // automatically and run as before, including /api routes.
  output: 'export',

  // Next/Image needs the Node-side loader; with static export we either
  // disable optimisation or use a custom remote loader. The app doesn't
  // use Next/Image anywhere so we just unblock the build.
  images: { unoptimized: true },

  // Cloudflare Pages serves `/foo` and `/foo/` interchangeably and
  // expects `/foo/index.html` in the output. Trailing-slash mode makes
  // that the default.
  trailingSlash: true,
};

export default nextConfig;
