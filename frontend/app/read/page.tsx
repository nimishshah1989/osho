'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, Search, ExternalLink } from 'lucide-react';
import Nav from '../../components/Nav';
import { useLocale } from '../../lib/i18n';

interface Paragraph {
  sequence_number: number;
  content: string;
}

interface DiscourseResponse {
  event: {
    id: string;
    title: string | null;
    date: string | null;
    location: string | null;
    language: string | null;
  };
  paragraphs: Paragraph[];
}

function ReaderInner() {
  const { t } = useLocale();
  const searchParams = useSearchParams();
  const title = searchParams?.get('title') ?? '';
  const eventId = searchParams?.get('event_id') ?? '';

  const [data, setData] = useState<DiscourseResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!title && !eventId) {
      setError('No discourse selected.');
      setLoading(false);
      return;
    }

    let cancelled = false;
    const qs = new URLSearchParams();
    if (eventId) qs.set('event_id', eventId);
    else if (title) qs.set('title', title);

    fetch(`/api/discourse?${qs.toString()}`)
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error((body && body.error) || `Upstream status ${res.status}`);
        return body as DiscourseResponse;
      })
      .then((body) => {
        if (!cancelled) setData(body);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message || 'The discourse could not be retrieved.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [title, eventId]);

  const headerTitle = data?.event.title ?? title ?? t('read.discourse');

  const sannyasWikiUrl = headerTitle
    ? `https://www.sannyas.wiki/${encodeURIComponent(headerTitle.replace(/ /g, '_'))}`
    : null;

  return (
    <>
      <Nav />
      <main className="min-h-screen bg-[rgb(var(--bg))] text-[rgb(var(--fg))] selection:bg-gold/30">
        <div className="max-w-3xl mx-auto pt-28 pb-24 px-6 md:px-8">
          <Link
            href="/archive"
            className="inline-flex items-center gap-2 text-[10px] tracking-[0.35em] uppercase text-stone-500 dark:text-ivory/70 hover:text-[rgb(var(--fg))] transition-colors mb-10 font-medium"
          >
            <ArrowLeft size={14} /> {t('read.back')}
          </Link>

          <header className="mb-12 border-b border-gold/20 dark:border-gold/15 pb-8">
            <h1 className="text-2xl md:text-3xl font-light tracking-wide mb-4 text-[rgb(var(--fg))]">
              {headerTitle}
            </h1>
            {data?.event && (
              <div className="flex flex-wrap gap-x-6 gap-y-2 text-[11px] tracking-[0.25em] uppercase text-stone-500 dark:text-ivory/75">
                {data.event.date && <span className="text-gold font-medium">{data.event.date}</span>}
                {data.event.location && <span>{data.event.location}</span>}
                {data.event.language && <span>{data.event.language}</span>}
                {data.paragraphs.length > 0 && (
                  <span>
                    {t(
                      data.paragraphs.length === 1
                        ? 'read.paragraphs.one'
                        : 'read.paragraphs.many',
                      { n: data.paragraphs.length },
                    )}
                  </span>
                )}
              </div>
            )}
            {sannyasWikiUrl && (
              <a
                href={sannyasWikiUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1.5 mt-3 text-[10px] tracking-[0.25em] uppercase text-gold/70 hover:text-gold transition-colors font-medium"
              >
                <ExternalLink size={12} />
                sannyas.wiki →
              </a>
            )}
          </header>

          {loading && (
            <div className="animate-pulse text-[11px] tracking-[0.4em] uppercase text-gold/80 font-medium">
              {t('read.loading')}
            </div>
          )}

          {error && !loading && (
            <div className="border border-gold/25 rounded-sm p-6">
              <div className="text-[11px] tracking-[0.35em] uppercase text-gold mb-2 font-medium">
                {t('read.error')}
              </div>
              <div className="text-base text-stone-600 dark:text-ivory/85 mb-4">{error}</div>
              <Link
                href={`/?q=${encodeURIComponent(title)}`}
                className="inline-flex items-center gap-2 text-[11px] tracking-[0.35em] uppercase text-gold hover:opacity-100 opacity-85 transition-opacity font-medium"
              >
                <Search size={14} /> {t('read.searchInstead')}
              </Link>
            </div>
          )}

          {data && !loading && !error && data.paragraphs.length === 0 && (
            <div className="text-stone-500 dark:text-ivory/80 text-base">
              {t('read.empty')}
            </div>
          )}

          {data && !loading && data.paragraphs.length > 0 && (
            <article className="prose-osho space-y-5">
              {data.paragraphs.map((p) => (
                <p key={p.sequence_number} className="whitespace-pre-wrap leading-loose">
                  {p.content}
                </p>
              ))}
            </article>
          )}
        </div>
      </main>
    </>
  );
}

export default function ReadPage() {
  return (
    <Suspense fallback={null}>
      <ReaderInner />
    </Suspense>
  );
}
