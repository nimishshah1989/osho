import { describe, it, expect } from 'vitest';
import { parseNear, rewriteQuery, scopeWordToContent } from '../queryRewrite';

describe('rewriteQuery', () => {
  it('rewrites title:foo to title_search:foo and leaves it alone', () => {
    expect(rewriteQuery('title:vigyan')).toBe('title_search:vigyan');
  });

  it('leaves a literal phrase alone (still searches all columns)', () => {
    expect(rewriteQuery('"Satyam Shivam"')).toBe('"Satyam Shivam"');
  });

  it('replaces an apostrophe in a bag-of-words query (#4)', () => {
    // A bare apostrophe is an FTS5 syntax error; the tokenizer splits on
    // it anyway, so women's -> women s yields the same matched tokens.
    expect(rewriteQuery("a new vision of women's liberation"))
      .toBe('{content} : (a new vision of women s liberation)');
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
});


describe('scopeWordToContent', () => {
  it('wraps a word in the FTS5 content-column filter', () => {
    expect(scopeWordToContent('politicians')).toBe('{content} : (politicians)');
  });
});
