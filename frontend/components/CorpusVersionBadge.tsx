'use client';

import { useEffect, useState } from 'react';

export default function CorpusVersionBadge() {
  const [version, setVersion] = useState<string | null | undefined>(undefined);

  useEffect(() => {
    fetch('/api/version')
      .then((r) => r.json())
      .then((d) => setVersion(d.corpus_version ?? null))
      .catch(() => setVersion(null));
  }, []);

  if (!version) return null;

  return (
    <p className="text-[12px] text-stone-400 dark:text-ivory/40 mt-2">
      Data version {version}
    </p>
  );
}
