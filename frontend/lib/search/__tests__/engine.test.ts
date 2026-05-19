/**
 * Engine integration tests. These mirror the assertions in the Python
 * suite (scripts/tests/test_search.py) so the desktop / PWA backend
 * agrees with the FastAPI backend on every search scenario we've
 * shipped.
 */
import { describe, it, expect } from 'vitest';
import { discourse, search, SearchError } from '../engine';
import { seedDatabase } from './seed';

function freshEngine() {
  return seedDatabase().engine;
}

// ─── Basic search ────────────────────────────────────────────────────────

describe('search() — basic', () => {
  it('returns ranked events for a single-word query', () => {
    const r = search(freshEngine(), { q: 'meditation' });
    expect(r.total).toBeGreaterThanOrEqual(1);
    const titles = r.events.map((e) => e.title);
    expect(titles).toContain('The Book of Secrets ~ 01'); // content match
  });

  it('matches exact phrase', () => {
    const r = search(freshEngine(), { q: '"become silent"' });
    const hits = r.events.flatMap((e) => e.hits.map((h) => h.content));
    expect(hits.some((h) => h.includes('Become silent'))).toBe(true);
  });

  it('handles NEAR(...)', () => {
    const r = search(freshEngine(), { q: 'NEAR(silence awareness)' });
    expect(r.total).toBeGreaterThanOrEqual(1);
  });

  it('handles OR', () => {
    const r = search(freshEngine(), { q: 'zen OR tantra' });
    const titles = r.events.map((e) => e.title ?? '');
    expect(titles.some((t) => t.includes('Zen') || t.includes('Tantra'))).toBe(true);
  });

  it('handles prefix wildcard', () => {
    const r = search(freshEngine(), { q: 'silenc*' });
    expect(r.total).toBeGreaterThanOrEqual(1);
  });

  it('honours title:foo shortcut', () => {
    const r = search(freshEngine(), { q: 'title:vigyan' });
    const titles = r.events.map((e) => e.title ?? '');
    expect(titles.length).toBeGreaterThan(0);
    expect(titles.every((t) => t.includes('Vigyan'))).toBe(true);
  });

  it('rejects invalid syntax', () => {
    expect(() => search(freshEngine(), { q: '"unclosed' })).toThrow(SearchError);
  });
});


// ─── Proximity (politicians/mafia) ───────────────────────────────────────

describe('NEAR cross-paragraph augmentation', () => {
  it('finds 2 events for politicians mafia within 30 words', () => {
    const r = search(freshEngine(), { q: 'NEAR(politicians mafia, 30)' });
    expect(r.total).toBeGreaterThanOrEqual(2);
  });

  it('finds the genuine cross-paragraph case in e2', () => {
    const r = search(freshEngine(), { q: 'NEAR(politicians mafia, 30)' });
    const titles = r.events.map((e) => e.title);
    expect(titles).toContain('The Mustard Seed ~ 04'); // cross-paragraph only
    expect(titles).toContain('Light on the Path ~ 29');  // in-paragraph
  });

  it('does NOT match e5 — words are in adjacent paragraphs but far apart in tokens', () => {
    const r = search(freshEngine(), { q: 'NEAR(politicians mafia, 30)' });
    const titles = r.events.map((e) => e.title);
    expect(titles).not.toContain('Zen: The Quantum Leap ~ 02');
  });
});


// ─── Hindi anusvara, stemmed vs exact ────────────────────────────────────

describe('Stemmed vs Exact', () => {
  it('stemmed search finds inflections — teach matches teaching', () => {
    const r = search(freshEngine(), { q: 'teach' });
    const titles = r.events.map((e) => e.title);
    expect(titles).toContain('The Book of Secrets ~ 01');
  });

  it('exact search skips inflections — teach does NOT match teaching', () => {
    const r = search(freshEngine(), { q: 'teach', exact: true });
    const titles = r.events.map((e) => e.title);
    expect(titles).not.toContain('The Book of Secrets ~ 01');
  });

  it('stemmed search collapses anusvara/virama variants', () => {
    for (const q of ['अनन्त', 'अनंत']) {
      const r = search(freshEngine(), { q });
      const titles = r.events.map((e) => e.title);
      expect(titles).toContain('Dekh Kabira Roya ~ 17');
      expect(titles).toContain('Dhammapada ~ 03');
    }
  });

  it('exact search keeps anusvara variants distinct', () => {
    const r = search(freshEngine(), { q: 'अनन्त', exact: true });
    const titles = r.events.map((e) => e.title);
    expect(titles).toContain('Dekh Kabira Roya ~ 17');
    expect(titles).not.toContain('Dhammapada ~ 03');
  });
});


// ─── Title-exclusion (Sugit Satyam Shivam case) ──────────────────────────

describe('title-only matches excluded from multi-word search', () => {
  it('multi-word search Satyam Shivam excludes title-only series matches', () => {
    const r = search(freshEngine(), { q: 'Satyam Shivam' });
    const titles = r.events.map((e) => e.title);
    expect(titles).not.toContain('Satyam Shivam Sundaram ~ 01');
    expect(titles).not.toContain('Satyam Shivam Sundaram ~ 02');
  });

  it('NEAR also excludes title-only matches', () => {
    const r = search(freshEngine(), { q: 'NEAR(Satyam Shivam, 30)' });
    const titles = r.events.map((e) => e.title);
    expect(titles).not.toContain('Satyam Shivam Sundaram ~ 01');
  });

  it('phrase search still finds the series (deliberate)', () => {
    const r = search(freshEngine(), { q: '"Satyam Shivam"' });
    const titles = r.events.map((e) => e.title);
    expect(titles).toContain('Satyam Shivam Sundaram ~ 01');
  });

  it('explicit title: filter still works', () => {
    const r = search(freshEngine(), { q: 'title:Satyam' });
    const titles = r.events.map((e) => e.title);
    expect(titles).toContain('Satyam Shivam Sundaram ~ 01');
  });

  it('multi-word content matches still work', () => {
    const r = search(freshEngine(), { q: 'techniques meditation' });
    const titles = r.events.map((e) => e.title);
    expect(titles).toContain('Vigyan Bhairav Tantra ~ 12');
  });
});


// ─── Language + translated_from filters ──────────────────────────────────

describe('filters', () => {
  it('language=Hindi excludes English events', () => {
    const r = search(freshEngine(), { q: 'meditation', language: 'Hindi' });
    for (const ev of r.events) expect(ev.language).toBe('Hindi');
  });

  it('language=English excludes Hindi events', () => {
    const r = search(freshEngine(), { q: 'Nietzsche', language: 'English' });
    expect(r.total).toBeGreaterThanOrEqual(1);
    for (const ev of r.events) expect(ev.language).toBe('English');
  });

  it('original=true excludes translations', () => {
    const r = search(freshEngine(), { q: 'meditation', original: true });
    const titles = r.events.map((e) => e.title);
    expect(titles).not.toContain('The Path of Meditation (Translation)');
    // Original-content match should still come through.
    expect(titles).toContain('The Book of Secrets ~ 01');
  });

  it('original=false includes translations', () => {
    const r = search(freshEngine(), { q: 'meditation' });
    const titles = r.events.map((e) => e.title);
    expect(titles).toContain('The Path of Meditation (Translation)');
  });
});


// ─── Counts ──────────────────────────────────────────────────────────────

describe('hit counts', () => {
  it('total_hits >= total', () => {
    const r = search(freshEngine(), { q: 'meditation' });
    expect(r.total_hits).toBeGreaterThanOrEqual(r.total);
  });

  it('each event reports its hit_count', () => {
    const r = search(freshEngine(), { q: 'meditation' });
    for (const ev of r.events) {
      expect(ev.hit_count).toBeGreaterThanOrEqual(1);
      expect(ev.hit_count).toBeGreaterThanOrEqual(ev.hits.length);
    }
  });
});


// ─── discourse() ─────────────────────────────────────────────────────────

describe('discourse()', () => {
  it('returns paragraphs in sequence_number order', () => {
    const r = discourse(freshEngine(), { eventId: 'h1' });
    expect(r.event.language).toBe('Hindi');
    expect(r.paragraphs.length).toBeGreaterThan(0);
    const seqs = r.paragraphs.map((p) => p.sequence_number);
    const sorted = [...seqs].sort((a, b) => a - b);
    expect(seqs).toEqual(sorted);
  });

  it('looks up by title', () => {
    const r = discourse(freshEngine(), { title: 'Zen: The Quantum Leap ~ 02' });
    expect(r.event.title).toBe('Zen: The Quantum Leap ~ 02');
  });

  it('404s when not found', () => {
    expect(() => discourse(freshEngine(), { eventId: 'nonexistent' })).toThrow(SearchError);
  });

  it('strips Shailendra source line from content', () => {
    const r = discourse(freshEngine(), { eventId: 'h3' });
    for (const p of r.paragraphs) {
      expect(p.content).not.toContain('Shailendra');
    }
  });

  it('attaches hl markers when q= is provided', () => {
    const r = discourse(freshEngine(), { eventId: 'h2', q: 'धर्म' });
    const hl = r.paragraphs.find((p) => p.hl);
    expect(hl?.hl ?? '').toContain('«');
  });
});


// ─── Shailendra stripping in search hits ─────────────────────────────────

describe('Shailendra stripping in search hits', () => {
  it('removes the source line from displayed hits', () => {
    const r = search(freshEngine(), { q: 'प्रवचन महत्वपूर्ण' });
    for (const ev of r.events) {
      for (const hit of ev.hits) {
        expect(hit.content).not.toContain('Shailendra');
      }
    }
  });
});


// ─── Metadata paragraph filtering ────────────────────────────────────────

describe('metadata paragraph filtering', () => {
  it('skips seq 0 in display hits', () => {
    const r = search(freshEngine(), { q: 'vigyan' });
    for (const ev of r.events) {
      for (const hit of ev.hits) {
        expect(hit.sequence_number).not.toBe(0);
      }
    }
  });

  it('skips sannyas.wiki boilerplate', () => {
    const r = search(freshEngine(), { q: 'vigyan' });
    for (const ev of r.events) {
      for (const hit of ev.hits) {
        expect(hit.content.toLowerCase().startsWith('event page in sannyas')).toBe(false);
      }
    }
  });
});
