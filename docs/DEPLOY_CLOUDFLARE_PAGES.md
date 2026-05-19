# Deploying the PWA to Cloudflare Pages

Use this when the regular Vercel / oshoarchives.com path isn't
available — Cloudflare Pages is free, deploys from the same repo,
and gives a stable `*.pages.dev` URL you can hand to initial users.
Once a host's URL is shared, the PWA install flow works exactly
like it does on oshoarchives.com: install → corpus downloads → run
fully offline.

## What ends up where

```
GitHub repo                          The osho codebase.
   │
   ▼
Cloudflare Pages                     Auto-builds on every push to main.
   ├── Static shell (HTML/JS/CSS)    Served from xxxxx.pages.dev.
   └── Service worker + manifest     Lets the browser install the PWA.

GitHub Releases (`corpus-latest`)    Hosts osho.db.zst (~400 MB).
   ▼
User's device (OPFS)                 Decompressed corpus,
                                      ~1.6 GB, queried by sqlite-wasm.
```

The user's first launch:

1. Visit `https://xxxxx.pages.dev` once with Wi-Fi.
2. Browser offers **Install**.
3. App downloads `osho.db.zst` from GitHub Releases (~400 MB), decompresses
   into OPFS.
4. After that — fully offline, forever.

## One-time setup on Cloudflare Pages

1. Sign in at <https://dash.cloudflare.com>. Free account is fine.
2. **Workers & Pages** → **Create** → **Pages** → **Connect to Git**.
3. Authorise the GitHub integration → pick the `osho` repo.
4. Configure the build:

   | Setting | Value |
   | --- | --- |
   | Project name | `osho-archives` (or whatever you want — controls the URL) |
   | Production branch | `main` |
   | Framework preset | **None** (we set it manually below) |
   | Build command | `cd frontend && npm install && npm run build:static` |
   | Build output directory | `frontend/out` |
   | Root directory | (leave empty — the build script does the `cd`) |
   | Node version | `20` (set in **Environment variables** as `NODE_VERSION=20`) |

5. Add the corpus URL as an environment variable (Production scope):

   ```
   NEXT_PUBLIC_CORPUS_URL=https://github.com/nimishshah1989/osho/releases/download/corpus-latest/osho.db.zst
   ```

   The `NEXT_PUBLIC_` prefix is required for Next.js to embed it in
   the client bundle. Without this variable the offline-corpus
   download silently doesn't start; the app still serves but won't
   work offline.

6. **Save and Deploy**.

First build takes ~3 minutes. When it completes, Cloudflare shows
the production URL (e.g. `osho-archives.pages.dev`).

## What `npm run build:static` does

```
rm -rf app/api && next build
```

The `app/api/*` routes are server-side proxies that depend on a
Node runtime — they don't exist on a static host. Stripping them
before `next build` keeps the build clean. `next.config.mjs` has
`output: 'export'` so the build emits a fully-prerendered tree in
`frontend/out/` (about 6 MB).

`next.config.mjs` also sets `trailingSlash: true` so the URLs
Cloudflare serves match what the build emits, and
`images: { unoptimized: true }` so the static export doesn't need a
runtime image loader.

The script is destructive in your working tree (removes
`app/api/`), so don't run it locally without committing first.
Cloudflare runs every build in a fresh checkout, so the destruction
never leaks.

## Custom domain

In the Cloudflare Pages project → **Custom domains** → **Set up a
custom domain**. Point e.g. `archives.example.org` at the project.
Cloudflare manages the TLS certificate automatically.

## Handing the URL to users

Once the build is green, share the URL — `osho-archives.pages.dev`
or whatever custom domain you set. Anyone visiting it on a modern
phone or laptop gets the install prompt; after install, the corpus
downloads once and the app works offline. Same flow as
`oshoarchives.com` would have been.

No app stores, no signed installers, nothing to email. The URL is
the installer.

## Updates

Every push to `main` auto-triggers a Cloudflare Pages build.
Service worker picks up the new shell on the user's next launch.
Corpus refresh is independent — the nightly `publish-corpus`
workflow updates the GitHub Release; users currently need to clear
site data to pull the new corpus. (A "Refresh corpus" button is on
the backlog.)

## Removing the deployment

When `oshoarchives.com` is live again, you can either:

- **Keep Cloudflare Pages running** as a mirror. Free, harmless.
- **Add the domain** as a redirect on Cloudflare → point at the
  primary URL.
- **Delete the Pages project**. The URL stops resolving; users who
  already installed the PWA keep using it offline (no impact on
  them) until they reinstall via the new URL.
