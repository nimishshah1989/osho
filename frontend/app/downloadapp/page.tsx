import Nav from '../../components/Nav';
import { OfflineSetup } from '../../components/OfflineSetup';

export const metadata = {
  title: 'Read Offline — Osho Discourse Search',
};

export default function DownloadAppPage() {
  return (
    <>
      <Nav />
      <main className="min-h-screen bg-[rgb(var(--bg))] text-[rgb(var(--fg))] pt-24 pb-20">
        <div className="max-w-xl mx-auto px-6">
          <h1 className="text-[11px] tracking-[0.35em] uppercase text-stone-400 dark:text-ivory/50 mb-2">
            Osho Discourse Search
          </h1>
          <p className="text-2xl font-light mb-4">Read Offline</p>
          <p className="text-[14px] text-stone-500 dark:text-ivory/60 leading-relaxed mb-10">
            Put the whole archive on this device. After a one-time setup it
            works with no internet — search every discourse, anywhere. It
            takes a few minutes.
          </p>

          <OfflineSetup />

          <p className="text-[12px] text-stone-400 dark:text-ivory/40 leading-relaxed mt-12 border-t border-gold/10 pt-6">
            Tip: open your browser&apos;s menu and choose <b>Install</b> (or
            &ldquo;Add to Home Screen&rdquo;) to keep Osho Archives on your
            device like an app. The archive itself lives entirely on your
            device once loaded — no further downloads.
          </p>
        </div>
      </main>
    </>
  );
}
