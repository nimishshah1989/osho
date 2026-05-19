'use client';

// `/ask` was the old search route. This page only exists to forward
// inbound links to the new home at `/`. We do the navigation client-
// side via `useEffect` + `router.replace` (the server `redirect()`
// helper can't run under `output: 'export'`), wrapped in a Suspense
// boundary because `useSearchParams` is the trigger for Next's CSR
// bailout. A `<meta http-equiv="refresh">` is included as a no-JS
// fallback so crawlers still chase the redirect even before hydration.

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
      <meta httpEquiv="refresh" content="0; url=/" />
      <main style={{ padding: '2rem', textAlign: 'center', opacity: 0.6 }}>
        Redirecting…
      </main>
      <Suspense fallback={null}>
        <AskRedirect />
      </Suspense>
    </>
  );
}
