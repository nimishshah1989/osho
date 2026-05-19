/**
 * Devanagari normalisation — keep me in lockstep with
 * `_normalize_devanagari` in `scripts/cloud_api.py` and the identical
 * function in `scripts/build_fts.py`. Both index-time AND query-time
 * have to apply the same transformation, otherwise अनन्त and अनंत
 * (and their friends) tokenise to different strings and silently miss
 * each other.
 *
 * The rule: nasal-consonant + virama → anusvara (ं) when the nasal
 * belongs to the same phonological class as the following consonant.
 * So:
 *   अनन्त → अनंत
 *   सम्भव → संभव
 *   मन्त्र → मंत्र
 * But NOT when the cluster crosses classes (न्य in न्याय stays as-is).
 */

const VIRAMA = '्';     // ्
const ANUSVARA = 'ं';   // ं

// (nasal codepoint, consonant-range start codepoint, consonant-range end codepoint)
const NASAL_RULES: ReadonlyArray<readonly [string, string, string]> = [
  ['ङ', 'क', 'ङ'], // ङ before क-ङ (velar)
  ['ञ', 'च', 'ञ'], // ञ before च-ञ (palatal)
  ['ण', 'ट', 'ण'], // ण before ट-ण (retroflex)
  ['न', 'त', 'न'], // न before त-न (dental)
  ['म', 'प', 'म'], // म before प-म (labial)
];

// Pre-compile one regex per rule so per-call cost is just five `.replace()`s.
const NASAL_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = NASAL_RULES.map(
  ([nasal, lo, hi]) => {
    const pattern = new RegExp(
      `${escapeRegex(nasal + VIRAMA)}(?=[${escapeRegex(lo)}-${escapeRegex(hi)}])`,
      'gu',
    );
    return [pattern, ANUSVARA] as const;
  },
);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Normalise a Devanagari string to its canonical anusvara form. Non-Devanagari
 *  text passes through unchanged. Applies Unicode NFC first so multi-codepoint
 *  sequences settle into a stable shape before the nasal rules run. */
export function normalizeDevanagari(text: string): string {
  if (!text) return text;
  let out = text.normalize('NFC');
  for (const [re, replacement] of NASAL_PATTERNS) {
    out = out.replace(re, replacement);
  }
  return out;
}
