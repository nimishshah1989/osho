import Nav from '../../components/Nav';

export const metadata = {
  title: 'Read Offline — Osho Discourse Search',
};

// The corpus archive is hosted off-site (e.g. a Google Drive share
// link) so nothing large is served from oshoarchives.com itself. The
// link is an env var so the file can be re-hosted without a code
// change; when unset the page shows a "coming soon" placeholder.
const DOWNLOAD_URL = process.env.NEXT_PUBLIC_CORPUS_DOWNLOAD_URL ?? '';


function Step({
  n, title, children,
}: { n: number; title: string; children: React.ReactNode }) {
  return (
    <section className="mb-10 flex gap-4">
      <div className="flex-shrink-0 w-7 h-7 rounded-full border border-gold/40 text-gold flex items-center justify-center text-[13px]">
        {n}
      </div>
      <div className="flex-1">
        <h2 className="text-[13px] tracking-[0.15em] uppercase text-gold mb-2">{title}</h2>
        <div className="text-[14px] text-stone-500 dark:text-ivory/60 leading-relaxed">
          {children}
        </div>
      </div>
    </section>
  );
}


export default function DownloadAppPage() {
  return (
    <>
      <Nav />
      <main className="min-h-screen bg-[rgb(var(--bg))] text-[rgb(var(--fg))] pt-24 pb-20">
        <div className="max-w-2xl mx-auto px-6">
          <h1 className="text-[11px] tracking-[0.35em] uppercase text-stone-400 dark:text-ivory/50 mb-2">
            Osho Discourse Search
          </h1>
          <p className="text-2xl font-light mb-4">Read Offline</p>
          <p className="text-[14px] text-stone-500 dark:text-ivory/60 leading-relaxed mb-12">
            Keep the complete Osho discourse archive on your own device — every
            talk, fully searchable, with no internet connection. A one-time
            setup in three steps.
          </p>

          <Step n={1} title="Install the app">
            Open <span className="text-[rgb(var(--fg))]">oshoarchives.com</span> in
            Chrome, Edge, or Safari, then choose{' '}
            <span className="text-gold">Install</span> (on a phone:{' '}
            <span className="text-gold">Add to Home Screen</span>). Osho Archives
            now sits on your device like any other app.
          </Step>

          <Step n={2} title="Download the archive file">
            <p className="mb-4">
              One file, about <span className="text-[rgb(var(--fg))]">550&nbsp;MB</span>,
              downloaded once — it holds the entire archive.
            </p>
            {DOWNLOAD_URL ? (
              <a
                href={DOWNLOAD_URL}
                className="inline-flex items-center gap-2 rounded-full bg-gold/15 text-gold px-6 py-2.5 text-[13px] tracking-[0.1em] uppercase hover:bg-gold/25 transition-colors"
              >
                Download the archive
              </a>
            ) : (
              <span className="text-[13px] text-stone-400 dark:text-ivory/40 italic">
                Download link coming soon.
              </span>
            )}
          </Step>

          <Step n={3} title="Load it into the app">
            Open the installed app. In the banner at the top, tap{' '}
            <span className="text-gold">Load from file</span> and choose the file
            you just downloaded. The app unpacks it (a few minutes) — and from
            then on everything works fully offline, instantly.
          </Step>

          <p className="text-[12px] text-stone-400 dark:text-ivory/40 leading-relaxed mt-12 border-t border-gold/10 pt-6">
            The archive file is large because it contains every discourse and the
            full search index. After the one-time load it lives entirely on your
            device — no further downloads, and search works with no connection at
            all.
          </p>
        </div>
      </main>
    </>
  );
}
