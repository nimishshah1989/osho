import React from 'react';

/**
 * Compact language marker for a record row (Archive / Constellation talk lists).
 *
 * Every talk that exists in both languages shows up twice with an identical
 * title, so the language is the only thing that tells the two rows apart
 * (Sugit 2026-11-19, item 1). Short codes keep the row narrow on phones; the
 * full name is in the tooltip / accessible label.
 */
const SHORT: Record<string, string> = {
  english: 'EN',
  hindi: 'HI',
  mixed: 'EN+HI',
};

export function languageShort(language: string | null | undefined): string {
  const raw = (language ?? '').trim();
  if (!raw) return '';
  return SHORT[raw.toLowerCase()] ?? raw;
}

export default function LanguageTag({
  language,
  className = '',
}: {
  language: string | null | undefined;
  className?: string;
}) {
  const label = languageShort(language);
  if (!label) return null;
  return (
    <span
      title={language ?? undefined}
      aria-label={language ?? undefined}
      className={
        'flex-shrink-0 text-[10px] tracking-[0.1em] uppercase font-medium px-1.5 py-0.5 rounded ' +
        'bg-stone-100 dark:bg-ivory/10 text-stone-500 dark:text-ivory/60 ' +
        className
      }
    >
      {label}
    </span>
  );
}
