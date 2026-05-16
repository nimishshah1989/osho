import { Suspense } from 'react';
import Nav from '../../components/Nav';
import TreeExplorer from '../../components/Archive/TreeExplorer';

export default function ArchivePage() {
  // TreeExplorer reads ?dim=… / ?group=… from useSearchParams to restore
  // the breadcrumb state (Sugit 2026-05-16). Next.js requires that to be
  // inside a Suspense boundary so the page can still be statically
  // prerendered without the query string.
  return (
    <>
      <Nav />
      <Suspense fallback={null}>
        <TreeExplorer />
      </Suspense>
    </>
  );
}
