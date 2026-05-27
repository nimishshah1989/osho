/** Render the `@time` header — stored verbatim in `events.date` —
 *  as a human-readable string for the search-result subtitle and
 *  the reader's header line.
 *
 *  Input shape (Sugit's convention):
 *      "1987-03-08-xm"   slot unknown
 *      "1986-04-19-am"   morning
 *      "1976-06-28-pm"   evening
 *      "1970-08-17"      no slot suffix
 *      "1971/1972 ?"     archivist note — non-ISO, passed through verbatim
 *
 *  Output: "DD MonthName YYYY". The slot suffix is intentionally NOT
 *  rendered here — Sugit's 2026-05-27 mail asked for the date to look
 *  the same as the document's body header (just the date, no slot).
 *  When the leading 10 chars aren't a valid YYYY-MM-DD date we return
 *  the string unchanged so archivist-style notes still render.
 */

type Locale = 'en' | 'hi';

const MONTHS_EN = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

const MONTHS_HI = [
  'जनवरी', 'फरवरी', 'मार्च', 'अप्रैल', 'मई', 'जून',
  'जुलाई', 'अगस्त', 'सितंबर', 'अक्टूबर', 'नवंबर', 'दिसंबर',
];

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:-[a-z]{2,3})?$/i;

export function formatReadableDate(raw: string | null | undefined, locale: Locale = 'en'): string {
  if (!raw) return '';
  const m = ISO_RE.exec(raw.trim());
  if (!m) return raw.trim();

  const [, yyyy, mm, dd] = m;
  const year = Number(yyyy);
  const monthIdx = Number(mm) - 1;
  const day = Number(dd);

  if (
    monthIdx < 0 || monthIdx > 11
    || day < 1 || day > 31
    || !Number.isFinite(year)
  ) {
    return raw.trim();
  }

  const months = locale === 'hi' ? MONTHS_HI : MONTHS_EN;
  return `${day} ${months[monthIdx]} ${year}`;
}
