import { describe, it, expect } from 'vitest';
import { hlTokenPositions, markersToGuillemets, HL_OPEN, HL_CLOSE } from '../highlight';

describe('hlTokenPositions', () => {
  it('counts no matches in unhighlighted text', () => {
    const [pos, total] = hlTokenPositions('hello world');
    expect(pos).toEqual([]);
    expect(total).toBe(2);
  });

  it('identifies a single matched token', () => {
    const hl = `the ${HL_OPEN}politicians${HL_CLOSE} have always been`;
    const [pos, total] = hlTokenPositions(hl);
    expect(pos).toEqual([1]);
    expect(total).toBe(5);
  });

  it('identifies multiple matched tokens', () => {
    const hl = `${HL_OPEN}politicians${HL_CLOSE} and ${HL_OPEN}mafia${HL_CLOSE}`;
    const [pos, total] = hlTokenPositions(hl);
    expect(pos).toEqual([0, 2]);
    expect(total).toBe(3);
  });

  it('keeps Devanagari combining marks inside the token (Mn/Mc)', () => {
    // अनन्त contains virama (U+094D, Mn). FTS5 with `categories
    // L* N* Co Mn Mc` keeps it inside the token. Our regex must agree
    // or the cross-paragraph NEAR augmentation will count token
    // distances incorrectly for Hindi queries.
    // पहले · अनन्त · बाद · में → 4 tokens, अनन्त at index 1.
    const hl = `पहले ${HL_OPEN}अनन्त${HL_CLOSE} बाद में`;
    const [pos, total] = hlTokenPositions(hl);
    expect(total).toBe(4);
    expect(pos).toEqual([1]);
  });

  it('keeps Devanagari matras (Mc) and anusvara (Mn) inside the token', () => {
    // धर्म has virama between र and म; अनंत has anusvara between
    // अन and त. Both must produce one token, not multiple.
    const hl = `${HL_OPEN}धर्म${HL_CLOSE} ${HL_OPEN}अनंत${HL_CLOSE}`;
    const [pos, total] = hlTokenPositions(hl);
    expect(total).toBe(2);
    expect(pos).toEqual([0, 1]);
  });

  it('returns empty for empty input', () => {
    expect(hlTokenPositions('')).toEqual([[], 0]);
  });
});

describe('markersToGuillemets', () => {
  it('converts \\x02 .. \\x03 to «..»', () => {
    expect(markersToGuillemets(`a ${HL_OPEN}b${HL_CLOSE} c`)).toBe('a «b» c');
  });
});
