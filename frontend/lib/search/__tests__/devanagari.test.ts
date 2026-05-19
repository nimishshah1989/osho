import { describe, it, expect } from 'vitest';
import { normalizeDevanagari } from '../devanagari';

describe('normalizeDevanagari', () => {
  it('collapses nasal+virama to anusvara within the same phonological class', () => {
    // Dental cluster
    expect(normalizeDevanagari('अनन्त')).toBe('अनंत');
    // Labial
    expect(normalizeDevanagari('सम्भव')).toBe('संभव');
    // Dental again
    expect(normalizeDevanagari('मन्त्र')).toBe('मंत्र');
  });

  it('leaves cross-class clusters alone', () => {
    // न्य crosses classes — must NOT collapse
    expect(normalizeDevanagari('न्याय')).toBe('न्याय');
  });

  it('passes non-Devanagari text through unchanged', () => {
    expect(normalizeDevanagari('hello world')).toBe('hello world');
    expect(normalizeDevanagari('')).toBe('');
  });

  it('is idempotent — running twice changes nothing', () => {
    const out = normalizeDevanagari('अनन्त सम्भव');
    expect(normalizeDevanagari(out)).toBe(out);
  });
});
