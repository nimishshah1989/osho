import { describe, it, expect } from 'vitest';
import { parseNear, parseQueryUnits, rewriteQuery, scopeWordToContent } from '../queryRewrite';

describe('rewriteQuery', () => {
  it('rewrites title:foo to title_search:foo and leaves it alone', () => {
    expect(rewriteQuery('title:vigyan')).toBe('title_search:vigyan');
  });

  it('leaves a literal phrase alone (still searches all columns)', () => {
    expect(rewriteQuery('"Satyam Shivam"')).toBe('"Satyam Shivam"');
  });

  it('strips a possessive apostrophe in a bag-of-words query (#4)', () => {
    // Possessive "'s" is dropped entirely (PR #95): otherwise the bare
    // "s" token matches almost everything. women's -> women.
    expect(rewriteQuery("a new vision of women's liberation"))
      .toBe('{content} : (a new vision of women liberation)');
  });

  it('keeps the apostrophe inside a quoted phrase (#4)', () => {
    expect(rewriteQuery('"women\'s liberation"')).toBe('"women\'s liberation"');
  });

  it('scopes bag-of-words queries to the content column', () => {
    // Sugit's case: Satyam Shivam shouldn't match the series via title.
    expect(rewriteQuery('Satyam Shivam')).toBe('{content} : (Satyam Shivam)');
  });

  it('scopes NEAR queries to content too', () => {
    expect(rewriteQuery('NEAR(politicians mafia, 30)')).toBe(
      '{content} : (NEAR(politicians mafia, 30))',
    );
  });

  it('applies Devanagari normalisation in stemmed mode', () => {
    expect(rewriteQuery('अनन्त')).toBe('{content} : (अनंत)');
  });

  it('skips Devanagari normalisation in exact mode', () => {
    expect(rewriteQuery('अनन्त', { exact: true })).toBe('{content} : (अनन्त)');
  });

  it('returns the empty string for an empty input', () => {
    expect(rewriteQuery('')).toBe('');
    expect(rewriteQuery('   ')).toBe('');
  });
});


describe('parseNear', () => {
  it('parses a bare NEAR(...)', () => {
    expect(parseNear('NEAR(politicians mafia, 30)')).toEqual({
      words: ['politicians', 'mafia'],
      distance: 30,
    });
  });

  it('peels the column-filter wrapper before parsing', () => {
    expect(parseNear('{content} : (NEAR(politicians mafia, 30))')).toEqual({
      words: ['politicians', 'mafia'],
      distance: 30,
    });
  });

  it('returns null for non-NEAR queries', () => {
    expect(parseNear('Satyam Shivam')).toBeNull();
    expect(parseNear('"a quoted phrase"')).toBeNull();
  });

  it('strips quotes around individual words', () => {
    expect(parseNear('NEAR("politicians" "mafia", 30)')).toEqual({
      words: ['politicians', 'mafia'],
      distance: 30,
    });
  });

  it('returns null when fewer than 2 words', () => {
    expect(parseNear('NEAR(politicians, 30)')).toBeNull();
  });

  it('strips function words (articles/prepositions/pronouns) — OCTP semantics', () => {
    // Regression: "falling in love you remain a child" Within-30 used to time
    // out (NetworkError) and return 0; now it matches on its content words.
    expect(parseNear('NEAR(falling in love you remain a child, 30)')).toEqual({
      words: ['falling', 'love', 'remain', 'child'],
      distance: 30,
    });
  });

  it('leaves a content-only NEAR query unchanged (parity)', () => {
    expect(parseNear('NEAR(enlightenment trust love, 20)')).toEqual({
      words: ['enlightenment', 'trust', 'love'],
      distance: 20,
    });
  });

  it('does not strip spiritually-loaded words; falls back when <2 remain', () => {
    // be/here/now are deliberately NOT stop-words → "be here now" is literal.
    expect(parseNear('NEAR(be here now, 30)')).toEqual({
      words: ['be', 'here', 'now'],
      distance: 30,
    });
    // all-function-word query: nothing content remains → keep the original.
    expect(parseNear('NEAR(of the, 30)')).toEqual({
      words: ['of', 'the'],
      distance: 30,
    });
  });

  it('strips Hindi function words (postpositions/conjunctions)', () => {
    expect(parseNear('NEAR(मन की शांति, 30)')).toEqual({
      words: ['मन', 'शांति'],
      distance: 30,
    });
    expect(parseNear('NEAR(प्रेम और ध्यान की शांति, 30)')).toEqual({
      words: ['प्रेम', 'ध्यान', 'शांति'],
      distance: 30,
    });
  });

  it('leaves Hindi content-only NEAR unchanged (parity)', () => {
    expect(parseNear('NEAR(धन धर्म विश्वास, 30)')).toEqual({
      words: ['धन', 'धर्म', 'विश्वास'],
      distance: 30,
    });
  });
});


describe('scopeWordToContent', () => {
  it('wraps a word in the FTS5 content-column filter', () => {
    expect(scopeWordToContent('politicians')).toBe('{content} : (politicians)');
  });
});


describe('parseQueryUnits', () => {
  it('splits a plain multi-word query into units', () => {
    expect(parseQueryUnits('love trust awareness')).toEqual(['love', 'trust', 'awareness']);
  });

  it('splits explicit-AND Hindi OR-expansion into units', () => {
    const units = parseQueryUnits('अनंत AND (प्रेम OR प्रेमा)');
    expect(units).toContain('अनंत');
    expect(units).toContain('प्रेम OR प्रेमा');
  });

  it('allows FTS5-keyword tokens when they come from explicit AND splitting (Bug 12/13)', () => {
    // "Agyat Ki Or" — "Or" is the Hindi word ओर (towards), not the FTS5 OR
    // operator. With explicit " AND " separators the backend must treat it
    // as a literal term, not bail to the legacy single-MATCH path.
    const units = parseQueryUnits('Agyat AND Ki AND Or AND समझाया');
    expect(units).not.toBeNull();
    expect(units).toContain('Or');
  });

  it('still bails on bare OR/AND/NOT between whitespace-split terms', () => {
    // `a OR b` without explicit AND separators — "OR" is a real operator here.
    expect(parseQueryUnits('a OR b')).toBeNull();
    expect(parseQueryUnits('love AND awareness')).not.toBeNull(); // AND as separator is fine
  });

  it('returns null for phrases and title-scoped queries', () => {
    expect(parseQueryUnits('"exact phrase"')).toBeNull();
    expect(parseQueryUnits('title:Satyam Shivam')).toBeNull();
  });
});
