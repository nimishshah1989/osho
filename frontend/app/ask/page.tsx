'use client';

import React, { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { Search, Sparkles, Loader2, BookOpen, Orbit, ExternalLink } from 'lucide-react';
import ReactMarkdown from 'react-markdown';
import Nav from '../../components/Nav';
import { consumeSSE } from '../../lib/sse';

interface Citation {
  id?: string;
  title: string | null;
  date: string | null;
  location: string | null;
  source_url?: string | null;
}

const SHOW_SOURCES_KEY = 'osho:showSources';
const RATE_LIMIT_SECONDS = 60;

function AskPageInner() {
  const searchParams = useSearchParams();
  const prefill = searchParams?.get('q') ?? '';
  const [query, setQuery] = useState(prefill);
  const [wisdom, setWisdom] = useState<string>('');
  const [citations, setCitations] = useState<Citation[]>([]);
  const [retrievedIds, setRetrievedIds] = useState<string[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [diagnostics, setDiagnostics] = useState<string | null>(null);
  const [showSources, setShowSources] = useState(false);
  const [rateLimitSecondsLeft, setRateLimitSecondsLeft] = useState(0);
  const tickRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    try {
      const stored = localStorage.getItem(SHOW_SOURCES_KEY);
      if (stored === 'true') setShowSources(true);
    } catch {
      /* localStorage may be blocked */
    }
  }, []);

  useEffect(() => {
    if (prefill && !query) setQuery(prefill);
  }, [prefill, query]);

  const toggleSources = useCallback((next: boolean) => {
    setShowSources(next);
    try {
      localStorage.setItem(SHOW_SOURCES_KEY, String(next));
    } catch {
      /* noop */
    }
  }, []);

  const startCountdown = useCallback(() => {
    setRateLimitSecondsLeft(RATE_LIMIT_SECONDS);
    if (tickRef.current) clearInterval(tickRef.current);
    tickRef.current = setInterval(() => {
      setRateLimitSecondsLeft((s) => {
        if (s <= 1) {
          if (tickRef.current) clearInterval(tickRef.current);
          return 0;
        }
        return s - 1;
      });
    }, 1000);
  }, []);

  useEffect(() => () => {
    if (tickRef.current) clearInterval(tickRef.current);
  }, []);

  const handleSearch = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!query.trim() || isLoading || rateLimitSecondsLeft > 0) return;

    setIsLoading(true);
    setWisdom('');
    setCitations([]);
    setRetrievedIds([]);
    setError(null);
    setDiagnostics(null);

    try {
      const response = await fetch('/api/ask', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query }),
      });

      if (response.status === 429) {
        startCountdown();
        setError('Free tier is resting. A breath of silence is required.');
        return;
      }
      if (!response.ok || !response.body) {
        throw new Error('Connection interrupted.');
      }

      await consumeSSE(response.body, (evt) => {
        if (evt.event === 'wisdom') {
          try {
            const parsed = JSON.parse(evt.data) as { chunk?: string };
            if (parsed.chunk) setWisdom((prev) => prev + parsed.chunk);
          } catch {
            setWisdom((prev) => prev + evt.data);
          }
        } else if (evt.event === 'citation') {
          try {
            const c = JSON.parse(evt.data) as Citation;
            setCitations((prev) => [...prev, c]);
          } catch {
            /* ignore malformed */
          }
        } else if (evt.event === 'retrieved') {
          try {
            const parsed = JSON.parse(evt.data) as { ids?: string[] };
            if (parsed.ids) setRetrievedIds(parsed.ids);
          } catch {
            /* ignore */
          }
        } else if (evt.event === 'error') {
          try {
            const parsed = JSON.parse(evt.data) as { message?: string };
            setError(parsed.message ?? 'The stillness was disturbed.');
          } catch {
            setError('The stillness was disturbed.');
          }
          void fetchEngineStatus();
        }
      });
    } catch (err) {
      console.error(err);
      setError('The stillness remains undisturbed. Please try again.');
      void fetchEngineStatus();
    } finally {
      setIsLoading(false);
    }
  };

  const fetchEngineStatus = async () => {
    try {
      const r = await fetch('/api/engine-status', { cache: 'no-store' });
      if (!r.ok) return;
      const s = (await r.json()) as {
        google_key_present?: boolean;
        openrouter_key_present?: boolean;
        searcher_warm?: boolean;
      };
      const missing: string[] = [];
      if (s.google_key_present === false) missing.push('GOOGLE_API_KEY');
      if (s.openrouter_key_present === false) missing.push('OPENROUTER_API_KEY');
      if (s.searcher_warm === false) missing.push('searcher (cold index)');
      if (missing.length > 0) {
        setDiagnostics(`Upstream is missing: ${missing.join(', ')}.`);
      }
    } catch {
      /* diagnostics are best-effort */
    }
  };

  const reset = () => {
    setWisdom('');
    setCitations([]);
    setRetrievedIds([]);
    setError(null);
    setQuery('');
  };

  const hasResult = Boolean(wisdom) || citations.length > 0;

  return (
    <>
      <Nav />
      <main className="min-h-screen bg-black text-ivory flex flex-col items-center justify-start pt-28 md:pt-36 px-6 pb-24">
        <div className="w-full max-w-2xl">
          <h1 className="text-sm tracking-[1em] uppercase opacity-40 mb-10 text-center text-gold">
            Ask Osho
          </h1>

          <form onSubmit={handleSearch} className="relative w-full mb-10">
            <input
              type="text"
              className="w-full bg-transparent border-b border-gold/30 py-4 text-xl md:text-2xl focus:border-gold outline-none transition-all placeholder:opacity-20 font-serif italic"
              placeholder="Ask anything..."
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              disabled={isLoading}
              aria-label="Question for Osho"
            />
            <button
              type="submit"
              className="absolute right-0 top-1/2 -translate-y-1/2 text-gold transition-all disabled:opacity-30"
              disabled={isLoading || !query.trim() || rateLimitSecondsLeft > 0}
              aria-label="Submit question"
            >
              {isLoading ? <Loader2 className="animate-spin" size={24} /> : <Search size={24} />}
            </button>
          </form>

          <label className="flex items-center gap-3 text-[10px] tracking-[0.3em] uppercase opacity-60 hover:opacity-100 transition-opacity select-none cursor-pointer mb-8">
            <input
              type="checkbox"
              checked={showSources}
              onChange={(e) => toggleSources(e.target.checked)}
              className="accent-gold"
            />
            Show Sources
          </label>

          {rateLimitSecondsLeft > 0 && (
            <div className="mb-8 border border-gold/20 rounded-sm p-4 text-sm opacity-80">
              Free tier is resting, please wait{' '}
              <span className="text-gold font-medium">{rateLimitSecondsLeft}s</span> and try again.
            </div>
          )}

          {error && !rateLimitSecondsLeft && (
            <div className="mb-8 text-sm font-serif italic">
              <div className="opacity-70">{error}</div>
              {diagnostics && (
                <div className="mt-2 text-[10px] tracking-[0.2em] uppercase font-sans opacity-50">
                  {diagnostics}
                </div>
              )}
            </div>
          )}

          {hasResult && (
            <div className="w-full animate-in fade-in duration-700">
              <div className="flex items-center gap-4 mb-8 opacity-20">
                <div className="h-[1px] flex-1 bg-gold" />
                <Sparkles size={12} />
                <div className="h-[1px] flex-1 bg-gold" />
              </div>

              <div className="wisdom-output prose-osho text-lg md:text-xl leading-relaxed font-serif italic opacity-90 pb-10">
                <ReactMarkdown
                  components={{
                    p: ({ children }) => <p className="mb-5">{children}</p>,
                    strong: ({ children }) => (
                      <strong className="text-gold not-italic font-medium">{children}</strong>
                    ),
                    em: ({ children }) => <em className="italic">{children}</em>,
                    h1: ({ children }) => (
                      <h2 className="text-base tracking-[0.3em] uppercase text-gold mt-8 mb-3 not-italic">
                        {children}
                      </h2>
                    ),
                    h2: ({ children }) => (
                      <h3 className="text-sm tracking-[0.3em] uppercase text-gold mt-6 mb-3 not-italic">
                        {children}
                      </h3>
                    ),
                    h3: ({ children }) => (
                      <h4 className="text-xs tracking-[0.3em] uppercase text-gold/80 mt-5 mb-2 not-italic">
                        {children}
                      </h4>
                    ),
                    ul: ({ children }) => (
                      <ul className="list-disc list-outside pl-6 mb-5 space-y-1">{children}</ul>
                    ),
                    ol: ({ children }) => (
                      <ol className="list-decimal list-outside pl-6 mb-5 space-y-1">{children}</ol>
                    ),
                    a: ({ href, children }) => (
                      <a
                        href={href ?? '#'}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-gold underline decoration-gold/40 hover:decoration-gold transition-colors"
                      >
                        {children}
                      </a>
                    ),
                    blockquote: ({ children }) => (
                      <blockquote className="border-l-2 border-gold/30 pl-4 my-5 opacity-80">
                        {children}
                      </blockquote>
                    ),
                  }}
                >
                  {wisdom}
                </ReactMarkdown>
              </div>

              {showSources && citations.length > 0 && (
                <section className="mt-6 border-t border-gold/10 pt-6">
                  <h2 className="text-[10px] tracking-[0.5em] uppercase text-gold/80 mb-4 flex items-center gap-2">
                    <BookOpen size={12} /> Sources from this synthesis
                  </h2>
                  <ul className="space-y-2 text-sm opacity-80">
                    {citations.map((c, i) => {
                      const titleNode = c.source_url ? (
                        <a
                          href={c.source_url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className="text-ivory underline decoration-gold/40 hover:decoration-gold inline-flex items-center gap-1"
                        >
                          {c.title ?? 'Unknown'}
                          <ExternalLink size={10} className="opacity-60" />
                        </a>
                      ) : (
                        <span className="text-ivory">{c.title ?? 'Unknown'}</span>
                      );
                      return (
                        <li key={`${c.title}-${c.date}-${i}`} className="leading-relaxed">
                          {titleNode}
                          {c.date ? <span className="opacity-50"> · {c.date}</span> : null}
                          {c.location ? <span className="opacity-50"> · {c.location}</span> : null}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              )}

              <div className="flex gap-6 items-center mt-10">
                <button
                  onClick={reset}
                  className="text-[10px] tracking-[0.5em] uppercase opacity-30 hover:opacity-100 transition-opacity text-gold"
                >
                  New Inquiry
                </button>
                {retrievedIds.length > 0 && (
                  <Link
                    href="/"
                    className="text-[10px] tracking-[0.5em] uppercase opacity-40 hover:opacity-100 transition-opacity text-gold flex items-center gap-2"
                  >
                    <Orbit size={12} /> Open the Nebula
                  </Link>
                )}
              </div>
            </div>
          )}
        </div>

        <footer className="fixed bottom-6 text-[9px] tracking-[0.4em] uppercase opacity-20">
          Oxford scholarly Edition | 2026
        </footer>
      </main>
    </>
  );
}

export default function AskPage() {
  return (
    <Suspense fallback={null}>
      <AskPageInner />
    </Suspense>
  );
}
