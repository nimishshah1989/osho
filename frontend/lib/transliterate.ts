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
  ['ny',  'ञ'],
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
 * Build an FTS5 query from a Devanagari string, expanding anusvara variants
 * into an OR expression so both spellings are searched.
 */
export function buildHindiFtsQuery(devanagari: string): string {
  const words = devanagari.trim().split(/\s+/).filter(Boolean);
  if (!words.length) return '';

  const expandedWords = words.map((w) => {
    const variants = expandAnusvara(w);
    return variants.length > 1 ? `(${variants.join(' OR ')})` : w;
  });

  return expandedWords.join(' ');
}
