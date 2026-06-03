import { describe, it, expect } from 'vitest';
import BetterSqlite3 from 'better-sqlite3';
import { buildHindiFtsQuery } from '../../transliterate';
import { rewriteQuery } from '../queryRewrite';

describe('buildHindiFtsQuery (#5 — Stemmed-mode OR expansion must be FTS5-safe)', () => {
  it('joins multi-word expansions with explicit AND, not a space', () => {
    const out = buildHindiFtsQuery('अनंत प्रेम');
    // Each word may expand to an (a OR b) group; groups MUST be joined by
    // AND because FTS5 has no implicit-AND between a group and a term.
    expect(out).toContain(' AND ');
    // No group immediately followed by another group / term with only a
    // space (that would be the implicit-AND that FTS5 rejects).
    expect(out).not.toMatch(/\)\s+\(/);   // ") (" — group space group
    expect(out).not.toMatch(/\)\s+[^A]/); // ") x" where x isn't the A of AND
  });

  it('produces output that parses inside the content-column filter', () => {
    // The real failure mode: buildHindiFtsQuery output -> rewriteQuery wrap
    // -> FTS5 MATCH. Must not throw. Build a tiny FTS5 index and run it.
    const db = new BetterSqlite3(':memory:');
    db.exec(
      "CREATE VIRTUAL TABLE fts USING fts5(content, "
      + "tokenize=\"porter unicode61 remove_diacritics 1 categories 'L* N* Co Mn Mc'\")",
    );
    db.prepare('INSERT INTO fts(content) VALUES (?)').run('अनंत प्रेम है यहाँ');

    for (const q of ['अनंत प्रेम', 'परमात्मा की तरफ जिसे जाना', 'ध्यान']) {
      const fts = rewriteQuery(buildHindiFtsQuery(q));
      // The assertion is simply: this does not throw a syntax error.
      expect(() => db.prepare('SELECT count(*) FROM fts WHERE fts MATCH ?').get(fts)).not.toThrow();
    }
    db.close();
  });

  it('handles mixed Roman+Devanagari queries without FTS5 keyword collision', () => {
    // "Agyat Ki Or समझाया" — "Or" is an FTS5 keyword that must not be treated
    // as an operator inside an explicit-AND unit list (Bug 12/13).
    const db = new BetterSqlite3(':memory:');
    db.exec(
      "CREATE VIRTUAL TABLE fts USING fts5(content, "
      + "tokenize=\"porter unicode61 remove_diacritics 1 categories 'L* N* Co Mn Mc'\")",
    );
    db.prepare('INSERT INTO fts(content) VALUES (?)').run('Agyat Ki Or समझाया अंधकारपूर्ण test');

    for (const q of ['Agyat Ki Or समझाया', 'Agyat Ki Or अंधकारपूर्ण', 'Ki And Not']) {
      const fts = rewriteQuery(buildHindiFtsQuery(q));
      // Must not throw a syntax error even though "Or", "And", "Not" look like FTS5 keywords.
      expect(() => db.prepare('SELECT count(*) FROM fts WHERE fts MATCH ?').get(fts)).not.toThrow();
    }
    db.close();
  });
});
