/**
 * Phonetic Roman-to-Devanagari transliteration for Hindi search input.
 * Uses longest-match-first scanning so "kh" binds before "k", etc.
 */

const HALANT = '्'; // ् virama — suppresses inherent vowel

// [roman, devanagari] — sorted longest-first within each group
const CONSONANTS: [string, string][] = [
  ['ksh', 'क्ष'],
  ['gy',  'ज्ञ'],
  ['chh', 'छ'],
  ['kh',  'ख'],
  ['gh',  'घ'],
  ['ch',  'च'],
  ['jh',  'झ'],
  ['Th',  'ठ'],
  ['Dh',  'ढ'],
  ['th',  'थ'],
  ['dh',  'ध'],
  ['ph',  'फ'],
  ['bh',  'भ'],
  ['Sh',  'ष'],
  ['sh',  'श'],
  ['ng',  'ङ'],
  // 'ny' omitted — ञ is vanishingly rare in Hindi; greedy match causes न+य splits
  // to misbehave in common words like 'sannyas'. Users can type ञ directly.
  ['T',   'ट'],
  ['D',   'ड'],
  ['N',   'ण'],
  ['k',   'क'],
  ['g',   'ग'],
  ['c',   'च'],
  ['j',   'ज'],
  ['t',   'त'],
  ['d',   'द'],
  ['n',   'न'],
  ['p',   'प'],
  ['f',   'फ'],
  ['b',   'ब'],
  ['m',   'म'],
  ['y',   'य'],
  ['r',   'र'],
  ['l',   'ल'],
  ['v',   'व'],
  ['w',   'व'],
  ['s',   'स'],
  ['h',   'ह'],
];

// [roman, standalone-letter, vowel-matra] — sorted longest-first
// matra is '' for the inherent 'a' (no explicit mark needed)
const VOWELS: [string, string, string][] = [
  ['aa', 'आ', 'ा'], // ा
  ['au', 'औ', 'ौ'], // ौ
  ['ai', 'ऐ', 'ै'], // ै
  ['ee', 'ई', 'ी'], // ी
  ['ii', 'ई', 'ी'],
  ['oo', 'ऊ', 'ू'], // ू
  ['uu', 'ऊ', 'ू'],
  ['ri', 'ऋ', 'ृ'], // ृ
  ['a',  'अ', ''],
  ['i',  'इ', 'ि'], // ि
  ['u',  'उ', 'ु'], // ु
  ['e',  'ए', 'े'], // े
  ['o',  'ओ', 'ो'], // ो
];

function convertWord(word: string): string {
  let result = '';
  let i = 0;
  let prevWasConsonant = false;

  while (i < word.length) {
    let matched = false;

    // Try vowel first (longer patterns tried first)
    for (const [pat, standalone, matra] of VOWELS) {
      if (word.startsWith(pat, i)) {
        result += prevWasConsonant ? matra : standalone;
        i += pat.length;
        prevWasConsonant = false;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Try consonant
    for (const [pat, dev] of CONSONANTS) {
      if (word.startsWith(pat, i)) {
        if (prevWasConsonant) result += HALANT;
        result += dev;
        i += pat.length;
        prevWasConsonant = true;
        matched = true;
        break;
      }
    }
    if (matched) continue;

    // Pass unrecognised characters through unchanged
    if (prevWasConsonant) prevWasConsonant = false;
    result += word[i];
    i++;
  }

  return result;
}

/** Convert a space-separated Roman string to Devanagari. */
export function romanToDevanagari(text: string): string {
  if (!text.trim()) return text;
  return text.replace(/[^\s]+/g, convertWord);
}

/**
 * Given a Devanagari string, return all spelling variants that differ only
 * in anusvara (ं) vs explicit nasal consonant (ङ्/ञ्/ण्/न्/म्).
 * E.g. अन्तर ↔ अंतर.
 */
export function expandAnusvara(text: string): string[] {
  const results = new Set<string>([text]);

  // Collapse explicit nasal+halant → anusvara
  const withAnusvara = text.replace(/[ङञणनम]्/g, 'ं');
  if (withAnusvara !== text) results.add(withAnusvara);

  // Expand anusvara → appropriate nasal based on the following consonant
  const NASAL: [RegExp, string][] = [
    [/ं([कखगघङ])/g, 'ङ्$1'],
    [/ं([चछजझञ])/g, 'ञ्$1'],
    [/ं([टठडढण])/g, 'ण्$1'],
    [/ं([तथदधन])/g, 'न्$1'],
    [/ं([पफबभम])/g, 'म्$1'],
  ];
  let withNasal = text;
  for (const [re, rep] of NASAL) withNasal = withNasal.replace(re, rep);
  if (withNasal !== text) results.add(withNasal);

  return Array.from(results);
}

/**
 * Expand a Devanagari word into vowel-length variants.
 *
 * Three expansions run on every word:
 *  1. Implicit 'a' between consonants → explicit ā (ा)
 *     e.g. ज्ञन (gyan) → ज्ञान  |  रमन → रामन
 *  2. Short i (ि) ↔ long ī (ी)   e.g. शांति → शांती
 *  3. Short u (ु) ↔ long ū (ू)   e.g. गुरु → गूरू
 *
 * All variants are returned as an array alongside the original;
 * duplicates are eliminated automatically.
 */
function expandVowelVariants(word: string): string[] {
  const results = new Set<string>([word]);

  // Unicode helpers
  const isConsonant = (c: string): boolean => {
    const cp = c.codePointAt(0)!;
    return (cp >= 0x0915 && cp <= 0x0939) || (cp >= 0x0958 && cp <= 0x095f);
  };
  const isMatraOrVirama = (c: string): boolean => {
    const cp = c.codePointAt(0)!;
    return cp >= 0x093e && cp <= 0x094d;
  };

  // 1. Insert explicit ā (ा) after the final consonant of a conjunct when
  //    followed by another consonant with no matra/virama.
  //    This handles "ज्ञन" → "ज्ञान" but NOT "इसका" → "इसाका".
  //    The virama check (U+094D) ensures we only expand inside conjuncts,
  //    not between ordinary standalone consonants that already carry inherent 'a'.
  const VIRAMA_CP = 0x094d;
  let withAA = '';
  for (let i = 0; i < word.length; i++) {
    withAA += word[i];
    const prevCp = i > 0 ? (word.codePointAt(i - 1) ?? 0) : 0;
    if (
      prevCp === VIRAMA_CP &&
      isConsonant(word[i]) &&
      i + 1 < word.length &&
      isConsonant(word[i + 1]) &&
      !isMatraOrVirama(word[i + 1])
    ) {
      withAA += 'ा';
    }
  }
  if (withAA !== word) results.add(withAA);

  // 2. Short i ↔ long ī
  const longI  = word.replace(/ि/g, 'ी');
  const shortI = word.replace(/ी/g, 'ि');
  if (longI  !== word) results.add(longI);
  if (shortI !== word) results.add(shortI);

  // 3. Short u ↔ long ū
  const longU  = word.replace(/ु/g, 'ू');
  const shortU = word.replace(/ू/g, 'ु');
  if (longU  !== word) results.add(longU);
  if (shortU !== word) results.add(shortU);

  return Array.from(results);
}

/**
 * Build an FTS5 query from a Devanagari string, expanding:
 *  - vowel-length variants  (a/ā, i/ī, u/ū)
 *  - anusvara variants      (ं ↔ ङ्/ञ्/ण्/न्/म्)
 *
 * Result is an OR expression covering all spelling variations so the
 * search catches the most common forms regardless of how the text was
 * originally typed or transcribed.
 */
export function buildHindiFtsQuery(devanagari: string): string {
  const words = devanagari.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';

  const expandedWords = words.map((w) => {
    const all = new Set<string>();
    // Expand vowel variants first, then anusvara within each
    for (const v of expandVowelVariants(w)) {
      for (const a of expandAnusvara(v)) {
        all.add(a);
      }
    }
    const variants = Array.from(all);
    return variants.length > 1 ? `(${variants.join(' OR ')})` : variants[0];
  });

  return expandedWords.join(' ');
}
