import Nav from '../../components/Nav';

export const metadata = {
  title: 'Help — Osho Discourse Search',
};

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-12">
      <h2 className="text-[11px] tracking-[0.3em] uppercase text-gold mb-4">{title}</h2>
      {children}
    </section>
  );
}

function Table({ rows }: { rows: [string, string, string?][] }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-[13px] border-collapse">
        <tbody>
          {rows.map(([col1, col2, col3], i) => (
            <tr key={i} className="border-b border-gold/10">
              <td className="py-2 pr-6 font-mono text-gold whitespace-nowrap">{col1}</td>
              <td className="py-2 pr-6 text-[rgb(var(--fg))]">{col2}</td>
              {col3 !== undefined && (
                <td className="py-2 text-stone-400 dark:text-ivory/50">{col3}</td>
              )}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function HelpPage() {
  return (
    <>
      <Nav />
      <main className="min-h-screen bg-[rgb(var(--bg))] text-[rgb(var(--fg))] pt-24 pb-20">
        <div className="max-w-2xl mx-auto px-6">

          <h1 className="text-[11px] tracking-[0.35em] uppercase text-stone-400 dark:text-ivory/50 mb-2">
            Osho Discourse Search
          </h1>
          <p className="text-2xl font-light text-[rgb(var(--fg))] mb-12">
            Search Guide
          </p>

          {/* ── Search modes ── */}
          <Section title="Search Modes">
            <p className="text-[14px] text-stone-500 dark:text-ivory/60 mb-4 leading-relaxed">
              Choose the mode using the buttons below the search bar.
            </p>
            <Table rows={[
              ['All words',     'Finds discourses containing every word you type, anywhere in the text.'],
              ['Exact phrase',  'Finds the exact sequence of words as typed, in that order.'],
              ['Near / Distance', 'Finds discourses where the words appear within N words of each other. Adjust the distance slider.'],
            ]} />
          </Section>

          {/* ── Search syntax ── */}
          <Section title="Search Syntax (All Words Mode)">
            <Table rows={[
              ['love meditation',    'Both words must appear (anywhere in the discourse)'],
              ['"love is god"',      'Exact phrase — words in this exact order'],
              ['meditat*',           'Prefix / wildcard — matches meditation, meditating, meditativeness …'],
              ['title:vigyan',       'Search only in discourse titles'],
              ['love OR compassion', 'Either word (at least one must appear)'],
            ]} />
          </Section>

          {/* ── Hindi typing ── */}
          <Section title="Hindi Typing (Roman → Devanagari)">
            <p className="text-[14px] text-stone-500 dark:text-ivory/60 mb-4 leading-relaxed">
              Switch to Hindi mode by clicking <span className="text-gold font-medium">हिं</span> in
              the top navigation. Then type normally in Roman (English) letters — a dropdown
              of Devanagari candidates appears as you type.
            </p>

            <div className="bg-stone-50 dark:bg-ivory/5 rounded-lg px-5 py-4 mb-6 text-[13px] space-y-1.5">
              <div className="flex gap-4">
                <span className="text-gold font-mono w-32 shrink-0">Space</span>
                <span className="text-stone-500 dark:text-ivory/60">Accept the top suggestion and move to the next word</span>
              </div>
              <div className="flex gap-4">
                <span className="text-gold font-mono w-32 shrink-0">1 – 8</span>
                <span className="text-stone-500 dark:text-ivory/60">Pick a specific suggestion by its number</span>
              </div>
              <div className="flex gap-4">
                <span className="text-gold font-mono w-32 shrink-0">↑ ↓ / Tab</span>
                <span className="text-stone-500 dark:text-ivory/60">Navigate through suggestions</span>
              </div>
              <div className="flex gap-4">
                <span className="text-gold font-mono w-32 shrink-0">Escape</span>
                <span className="text-stone-500 dark:text-ivory/60">Dismiss suggestions, keep the Roman text</span>
              </div>
              <div className="flex gap-4">
                <span className="text-gold font-mono w-32 shrink-0">Enter</span>
                <span className="text-stone-500 dark:text-ivory/60">Accept top suggestion and submit the search</span>
              </div>
            </div>

            <p className="text-[12px] text-stone-400 dark:text-ivory/40 mb-5">
              Suggestions are powered by Google Input Tools — the same engine used by Google
              Keyboard and Gboard. No special notation required: just type phonetically.
            </p>

            <h3 className="text-[10px] tracking-[0.25em] uppercase text-stone-400 dark:text-ivory/40 mb-3">
              Common examples
            </h3>
            <Table rows={[
              ['prem',      'प्रेम',    'love'],
              ['dhyan',     'ध्यान',    'meditation'],
              ['nahin',     'नहीं',     'no / not'],
              ['thik',      'ठीक',      'correct / okay'],
              ['sannyas',   'सन्न्यास', 'renunciation'],
              ['anand',     'आनंद',     'bliss'],
              ['satya',     'सत्य',     'truth'],
              ['shanti',    'शांति',    'peace'],
              ['mukti',     'मुक्ति',   'liberation'],
              ['prabhu',    'प्रभु',    'God / Lord'],
            ]} />
          </Section>

          {/* ── Proximity / Near ── */}
          <Section title="Proximity (Near) Search">
            <p className="text-[14px] text-stone-500 dark:text-ivory/60 mb-4 leading-relaxed">
              Near mode finds discourses where two or more words appear close together —
              within the same sentence, paragraph, or a few paragraphs depending on the
              distance setting.
            </p>
            <Table rows={[
              ['Distance 10',  'Words within ~10 tokens (a short phrase or sentence)'],
              ['Distance 30',  'Words within ~30 tokens (a sentence or two) — default'],
              ['Distance 100', 'Words within a passage (several sentences or paragraphs)'],
            ]} />
            <p className="text-[12px] text-stone-400 dark:text-ivory/40 mt-4">
              Words can appear in the same paragraph or in immediately adjacent paragraphs.
            </p>
          </Section>

          {/* ── Language filter ── */}
          <Section title="Language Filter">
            <p className="text-[14px] text-stone-500 dark:text-ivory/60 mb-4 leading-relaxed">
              Use the <span className="text-[rgb(var(--fg))]">Lang</span> filter below the search
              bar to restrict results.
            </p>
            <Table rows={[
              ['All',     'Search both English and Hindi discourses (default)'],
              ['English', 'English-language discourses only'],
              ['Hindi',   'Hindi-language discourses only'],
            ]} />
          </Section>

          {/* ── Date filter ── */}
          <Section title="Date / Period Filter">
            <p className="text-[14px] text-stone-500 dark:text-ivory/60 leading-relaxed">
              Enter a year range in the <span className="text-[rgb(var(--fg))]">Period</span> fields
              (e.g. <span className="font-mono text-gold">1974</span> –{' '}
              <span className="font-mono text-gold">1981</span>) to limit results to discourses
              given during that period. Discourses span 1962 – 1990. Leave blank to search all years.
            </p>
          </Section>

          {/* ── sannyas.wiki ── */}
          <Section title="sannyas.wiki Links">
            <p className="text-[14px] text-stone-500 dark:text-ivory/60 leading-relaxed">
              Each discourse detail panel includes a{' '}
              <span className="text-gold">sannyas.wiki ↗</span> link that opens the corresponding
              page on sannyas.wiki — a community reference site with additional information about
              each discourse series, dates, and locations.
            </p>
          </Section>

        </div>
      </main>
    </>
  );
}
