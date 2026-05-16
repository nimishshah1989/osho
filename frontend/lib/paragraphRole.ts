/**
 * Map a paragraph's semantic `role` (from the Word `ctp - ...` style on
 * ingest) to a Tailwind class string for display. This is what carries
 * the typographic intent of the original books and CD-ROMs through the
 * pipeline so the search UI doesn't render every paragraph as flat body
 * text.
 *
 * `role` is the slug produced by `_normalise_role` in `scripts/ingest_docx.py`
 * (e.g. "ctp - Sutra/Question" → "sutra_question"). Unknown or absent
 * roles render with no extra class — same as today's behaviour for any
 * paragraph that wasn't ingested from a styled .docx.
 *
 * Italic is the dominant differentiator in Antar's docs because that's
 * how the books distinguish question-from-answer and sutra-from-comment.
 * We keep colour changes subtle so the reading surface stays calm.
 */
export type ParagraphRole =
  | 'osho_talking'
  | 'other_talking_1'
  | 'other_talking_2'
  | 'sutra_question'
  | 'poem'
  | 'comments'
  | 'short_comments'
  | 'our_translation'
  | 'notes'
  | 'title'
  | 'event_info';

const ROLE_CLASSES: Record<string, string> = {
  // The talk itself — plain body, no class.
  osho_talking: '',
  // Interviewers / questioners — italic, slightly offset.
  other_talking_1: 'italic text-stone-700 dark:text-ivory/85',
  other_talking_2: 'italic text-stone-700 dark:text-ivory/85',
  // Sutras and questions Osho is commenting on — italic, gold-accented, indented.
  sutra_question: 'italic pl-4 border-l-2 border-gold/40 text-stone-700 dark:text-ivory/90',
  // Poems / verses — italic, centred (best-effort: small left padding).
  poem: 'italic pl-6 text-stone-700 dark:text-ivory/90',
  // Editorial commentary — smaller, italic, muted.
  comments: 'italic text-sm text-stone-500 dark:text-ivory/70',
  short_comments: 'italic text-sm text-stone-500 dark:text-ivory/70',
  // Translator's note — italic, distinct.
  our_translation: 'italic text-stone-600 dark:text-ivory/80',
  // Contextual notes (e.g. "[Interview with Lia Paradiso.]") — muted.
  notes: 'text-sm text-stone-500 dark:text-ivory/70',
  // These two are typically not rendered as body paragraphs — the title
  // is shown in the page header and event_info as metadata — but if they
  // do leak through we render them muted rather than swallow them.
  title: 'text-lg font-medium text-gold',
  event_info: 'text-xs uppercase tracking-wider text-stone-500 dark:text-ivory/60',
};

export function paragraphRoleClass(role: string | null | undefined): string {
  if (!role) return '';
  return ROLE_CLASSES[role] ?? '';
}

/** Paragraphs that are metadata, not content — callers may want to hide
 *  these in the full-discourse reader (they're already shown in the header). */
export function isMetadataRole(role: string | null | undefined): boolean {
  return role === 'title' || role === 'event_info';
}

/** Tiny className joiner: filters out empty/falsy entries so paragraphs
 *  without a role don't end up with a stray leading space, and so callers
 *  can pass conditional strings without ternary noise. Returns undefined
 *  when nothing is left, matching React's expectation for "no class". */
export function cx(...parts: (string | false | null | undefined)[]): string | undefined {
  const joined = parts.filter(Boolean).join(' ');
  return joined || undefined;
}
