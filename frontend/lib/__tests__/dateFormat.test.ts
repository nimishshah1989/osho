import { describe, it, expect } from 'vitest';
import { formatReadableDate } from '../dateFormat';

describe('formatReadableDate (EN)', () => {
  it('formats a plain ISO date', () => {
    expect(formatReadableDate('1970-08-17')).toBe('17 August 1970');
  });

  it('formats AM slot as morning', () => {
    expect(formatReadableDate('1986-04-19-am')).toBe('19 April 1986, morning');
  });

  it('formats PM slot as evening', () => {
    expect(formatReadableDate('1976-06-28-pm')).toBe('28 June 1976, evening');
  });

  it('omits unknown (xm) slot', () => {
    // xm = morning/evening unknown — display the date with no slot suffix.
    expect(formatReadableDate('1987-03-08-xm')).toBe('8 March 1987');
  });

  it("passes archivist notes through unchanged ('1971/1972 ?')", () => {
    expect(formatReadableDate('1971/1972 ?')).toBe('1971/1972 ?');
  });

  it('returns empty for null/undefined/empty input', () => {
    expect(formatReadableDate(null)).toBe('');
    expect(formatReadableDate(undefined)).toBe('');
    expect(formatReadableDate('')).toBe('');
  });

  it('passes through malformed dates verbatim', () => {
    expect(formatReadableDate('1987-13-40')).toBe('1987-13-40');
    expect(formatReadableDate('not a date')).toBe('not a date');
  });
});

describe('formatReadableDate (HI)', () => {
  it('formats ISO date with Devanagari month name', () => {
    expect(formatReadableDate('1970-08-17', 'hi')).toBe('17 अगस्त 1970');
  });

  it('localises the morning slot', () => {
    expect(formatReadableDate('1986-04-19-am', 'hi')).toBe('19 अप्रैल 1986, प्रातः');
  });

  it('localises the evening slot', () => {
    expect(formatReadableDate('1976-06-28-pm', 'hi')).toBe('28 जून 1976, सायं');
  });
});
