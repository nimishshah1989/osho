/**
 * Seed a better-sqlite3 in-memory database with the same fixture data
 * Python's `scripts/tests/conftest.py` uses. Lets the TS engine tests
 * exercise the same scenarios end-to-end against real FTS5.
 */
import BetterSqlite3 from 'better-sqlite3';
import { normalizeDevanagari } from '../devanagari';
import type { Database } from '../types';

export function seedDatabase(): { db: BetterSqlite3.Database; engine: Database } {
  const sqlite = new BetterSqlite3(':memory:');
  sqlite.exec(`
    CREATE TABLE events (
      id TEXT PRIMARY KEY, title TEXT NOT NULL,
      date TEXT, location TEXT, language TEXT,
      translated_from TEXT
    );
    CREATE TABLE paragraphs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_id TEXT NOT NULL,
      sequence_number INTEGER NOT NULL,
      content TEXT NOT NULL,
      role TEXT
    );
    CREATE VIRTUAL TABLE paragraphs_fts USING fts5(
      content, title UNINDEXED, event_id UNINDEXED,
      paragraph_id UNINDEXED, sequence_number UNINDEXED,
      title_search,
      tokenize = "porter unicode61 remove_diacritics 1 categories 'L* N* Co Mn Mc'"
    );
    CREATE VIRTUAL TABLE paragraphs_fts_exact USING fts5(
      content, title UNINDEXED, event_id UNINDEXED,
      paragraph_id UNINDEXED, sequence_number UNINDEXED,
      title_search,
      tokenize = "unicode61 remove_diacritics 1 categories 'L* N* Co Mn Mc'"
    );
  `);

  // (id, title, date, location, language, translated_from)
  const events: Array<[string, string, string, string, string, string]> = [
    ['e1', 'The Book of Secrets ~ 01',    '1973-01-01', 'Bombay', 'English', 'none'],
    ['e2', 'The Mustard Seed ~ 04',       '1974-08-21', 'Poona',  'English', 'none'],
    ['e3', 'Vigyan Bhairav Tantra ~ 12',  '1984-05-10', 'Pune',   'English', 'none'],
    ['e4', 'A Course on Meditation ~ 03', '1988-03-03', 'Pune',   'English', 'none'],
    ['e5', 'Zen: The Quantum Leap ~ 02',  '1989-04-04', 'Pune',   'English', 'none'],
    ['h1', 'Dekh Kabira Roya ~ 17',       '1978-06-15', 'Pune',   'Hindi',   'none'],
    ['h2', 'Dhammapada ~ 03',             '1979-09-10', 'Pune',   'Hindi',   'none'],
    ['h3', 'Ek Omkar Satnam ~ 05',        '1975-02-20', 'Bombay', 'Hindi',   'none'],
    ['t1', 'The Path of Meditation (Translation)', '1980-01-01', 'Pune', 'English', 'Hindi'],
    ['p1', 'Light on the Path ~ 29',      '1986-02-25', 'Pune',   'English', 'none'],
    ['p2', 'The Messiah Vol 1 ~ 15',      '1987-01-10', 'Pune',   'English', 'none'],
    ['ss1', 'Satyam Shivam Sundaram ~ 01', '1980-11-11', 'Pune', 'Hindi', 'none'],
    ['ss2', 'Satyam Shivam Sundaram ~ 02', '1980-11-12', 'Pune', 'Hindi', 'none'],
  ];
  const evInsert = sqlite.prepare(
    'INSERT INTO events (id,title,date,location,language,translated_from) VALUES (?,?,?,?,?,?)',
  );
  for (const e of events) evInsert.run(...e);

  // (id, event_id, sequence_number, content)
  const paragraphs: Array<[number, string, number, string]> = [
    [1, 'e1', 1, 'Meditation is not concentration. It is a state of no-mind.'],
    [2, 'e1', 2, 'Become silent and the universe begins to speak.'],
    [3, 'e2', 7, 'Love is the ultimate alchemy. Love transforms everything.'],
    [4, 'e3', 1, 'Vigyan Bhairav Tantra — one hundred and twelve techniques of meditation.'],
    [5, 'e4', 3, 'Silence is not absence of sound; silence is presence of awareness.'],
    [6, 'e5', 2, 'Zen is the only religion that will survive.'],
    [7, 'h1', 1, 'नहीं वह तो ठीक है, लेकिन बात कुछ और है।'],
    [8, 'h1', 5, 'जीवन में धन और धर्म दोनों जरूरी हैं। विश्वास रखो।'],
    [9, 'h1', 17, 'कहानियों से मुझे कुछ प्रेम है, यह बात सच है।'],
    [10, 'h2', 3, 'धन धर्म और विश्वास — ये तीनों साथ चलते हैं।'],
    [11, 'h2', 8, 'ध्यान में बैठो और मौन हो जाओ।'],
    [12, 'h3', 2, 'धन का मूल्य धर्म से है और विश्वास से जीवन चलता है।'],
    [13, 'h3', 5, "source: Shailendra's Hindi collection\nयह प्रवचन बहुत महत्वपूर्ण है।"],
    [14, 't1', 1, 'The path of meditation is the path of silence and awareness.'],
    [15, 'p1', 1, 'Nietzsche was a great philosopher. Nietzsche understood the superman.'],
    [16, 'p1', 3, 'Nietzsche proclaimed God is dead. This was Nietzsche\'s greatest insight.'],
    [17, 'p1', 7, 'Nietzsche\'s Zarathustra is one of the most significant books ever written.'],
    [18, 'p1', 12, 'Beyond good and evil — Nietzsche saw clearly what others could not.'],
    [19, 'p2', 5, 'Nietzsche once said that God is dead.'],
    [20, 'p1', 20, 'The politicians have always been in alliance with the mafia.'],
    [21, 'p2', 10, 'When politicians and the mafia join hands, the common man suffers.'],
    [24, 'e2', 4, 'Power corrupts every government and every assembly of politicians.'],
    [25, 'e2', 5, 'Mafia bosses thrive whenever such corruption goes unchecked.'],
    [26, 'e5', 80,
      'Politicians appear at the very beginning of this short paragraph and the rest '
      + 'of the paragraph rambles on about altogether unrelated matters, listing names '
      + 'of philosophers and saints, painting long tableaus of imagined gardens, weaving '
      + 'sentence after sentence of digression so the reader entirely forgets where the '
      + 'topic began before the paragraph eventually wanders to an unrelated close.'],
    [27, 'e5', 81,
      'Through pages of unrelated meditations the discourse meanders, touching upon '
      + 'silence, breath, dreams, longing, despair, compassion, surrender, prayer, '
      + 'fragrance, song, courage, music, wonder, awe, devotion, and only at the very '
      + 'end of all this digression does the word mafia surface again.'],
    [22, 'e3', 0, 'Vigyan Bhairav Tantra ~ 12'],
    [23, 'e3', 2, 'event page in sannyas.wiki: Vigyan Bhairav Tantra ~ 12.'],
    [40, 'ss1', 1, 'Truth is a state of being, not a doctrine to be believed.'],
    [41, 'ss1', 2, 'Listen to the heart, and the path opens by itself.'],
    [42, 'ss2', 1, 'Beauty without truth is decoration; truth without beauty is austerity.'],
    [30, 'e1', 50, 'The teaching of the masters is one and the same.'],
    [31, 'h1', 80, 'अनन्त — समय के पार जो है, वही अनन्त है।'],
    [32, 'h2', 90, 'अनंत यात्रा है, अंत नहीं।'],
  ];
  const paraInsert = sqlite.prepare(
    'INSERT INTO paragraphs (id, event_id, sequence_number, content) VALUES (?,?,?,?)',
  );
  for (const p of paragraphs) paraInsert.run(...p);

  // Mirror into both FTS tables, matching scripts/build_fts.py:
  //   paragraphs_fts        — Devanagari-normalised content
  //   paragraphs_fts_exact  — raw content (no normalisation)
  const ftsInsert = (table: string) => sqlite.prepare(
    `INSERT INTO ${table} (content,title,event_id,paragraph_id,sequence_number,title_search) VALUES (?,?,?,?,?,?)`,
  );
  const stmts = {
    fts: ftsInsert('paragraphs_fts'),
    exact: ftsInsert('paragraphs_fts_exact'),
  };
  for (const [pid, evId, seq, content] of paragraphs) {
    const title = events.find((e) => e[0] === evId)?.[1] ?? '';
    const normContent = normalizeDevanagari(content);
    const normTitle = normalizeDevanagari(title);
    stmts.fts.run(normContent, normTitle, evId, pid, seq, normTitle);
    stmts.exact.run(content, title, evId, pid, seq, title);
  }

  const engine: Database = {
    all<T>(sql: string, params: unknown[] = []): T[] {
      return sqlite.prepare(sql).all(...params) as T[];
    },
    get<T>(sql: string, params: unknown[] = []): T | undefined {
      return sqlite.prepare(sql).get(...params) as T | undefined;
    },
  };

  return { db: sqlite, engine };
}
