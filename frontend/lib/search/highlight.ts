/**
 * Parse FTS5 `highlight()` output to find which tokens matched.
 *
 * The backend wraps matched tokens with `\x02` ... `\x03` markers
 * (see `cloud_api.py:_hl_token_positions`). We mirror that here so the
 * cross-paragraph NEAR augmentation can compute real token distance.
 *
 * Marker characters are normally invisible (and never appear in Osho's
 * text), so they're a safe choice.
 */

export const HL_OPEN = '\x02';
export const HL_CLOSE = '\x03';

/**
 * Returns `[positions of matched tokens (0-indexed), total token count]`.
 *
 * Tokens are anything matching `[\p{L}\p{N}]+` after lowercasing —
 * Unicode-aware so Devanagari syllables count correctly.
 */
export function hlTokenPositions(hl: string): readonly [number[], number] {
  if (!hl) return [[], 0];
  // Insert whitespace around markers so a marker abutting a token
  // character doesn't get swallowed into the token. Lowercase to match
  // unicode61's default case-folding.
  const padded = hl
    .replace(new RegExp(HL_OPEN, 'g'), ` ${HL_OPEN} `)
    .replace(new RegExp(HL_CLOSE, 'g'), ` ${HL_CLOSE} `)
    .toLowerCase();
  const parts = padded.match(new RegExp(`${HL_OPEN}|${HL_CLOSE}|[\\p{L}\\p{N}]+`, 'gu'));
  if (!parts) return [[], 0];

  const positions: number[] = [];
  let total = 0;
  let inMatch = false;
  for (const p of parts) {
    if (p === HL_OPEN) {
      inMatch = true;
    } else if (p === HL_CLOSE) {
      inMatch = false;
    } else {
      if (inMatch) positions.push(total);
      total += 1;
    }
  }
  return [positions, total];
}

/** Convert FTS5's `\x02 ... \x03` markers to the «...» glyphs the
 *  frontend's `<Highlighted>` component looks for. */
export function markersToGuillemets(hl: string): string {
  return hl.split(HL_OPEN).join('«').split(HL_CLOSE).join('»');
}
