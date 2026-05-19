'use client';

// `/ask` is the old search route. We redirect to `/` (which carries
// any query string through unchanged).
//
// Two layers handle this:
//   1. Host-level. Cloudflare Pages reads `public/_redirects` and
//      issues a real 301 before this page is ever served. Vercel
//      doesn't honour that file, but it still runs Next.js's server
//      and we keep this route around for inbound links there.
//   2. Client-level. If the request slipped past the host redirect
//      (Vercel, or a static host without `_redirects` support), the
//      effect below replaces the URL on hydration.
//
// The earlier `<meta http-equiv="refresh">` in the page body has been
// removed — emitted from the body it isn't reliable as a no-JS
// fallback, and the host-level redirect is the proper replacement.

import { Suspense, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

function AskRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  useEffect(() => {
    const qs = searchParams?.toString() ?? '';
    router.replace(qs ? `/?${qs}` : '/');
  }, [router, searchParams]);
  return null;
}

export default function AskPage() {
  return (
    <>
      <main style={{ padding: '2rem', textAlign: 'center', opacity: 0.6 }}>
        Redirecting…
      </main>
      <Suspense fallback={null}>
        <AskRedirect />
      </Suspense>
    </>
  );
}
