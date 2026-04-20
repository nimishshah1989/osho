'use client';

import React, { Suspense, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, MessageCircle } from 'lucide-react';
import Nav from '../../components/Nav';

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
  };
  paragraphs: Paragraph[];
}

function ReaderInner() {
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
        if (!res.ok) {
          throw new Error((body && body.error) || `Upstream status ${res.status}`);
        }
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

  const headerTitle = data?.event.title ?? title ?? 'Discourse';

  return (
    <>
      <Nav />
      <main className="min-h-screen bg-black text-ivory/85 selection:bg-gold/30">
        <div className="max-w-3xl mx-auto pt-32 pb-24 px-6 md:px-8">
          <Link
            href="/"
            className="inline-flex items-center gap-2 text-[9px] tracking-[0.4em] uppercase opacity-50 hover:opacity-100 transition-opacity mb-10"
          >
            <ArrowLeft size={12} /> Back to the Nebula
          </Link>

          <header className="mb-12 border-b border-gold/10 pb-8">
            <h1 className="text-3xl md:text-4xl font-serif italic text-white tracking-wide mb-4">
              {headerTitle}
            </h1>
            {data?.event && (
              <div className="flex flex-wrap gap-x-6 gap-y-1 text-[10px] tracking-[0.3em] uppercase opacity-50">
                {data.event.date && <span className="text-gold">{data.event.date}</span>}
                {data.event.location && <span>{data.event.location}</span>}
                {data.paragraphs.length > 0 && (
                  <span>{data.paragraphs.length} paragraphs</span>
                )}
              </div>
            )}
          </header>

          {loading && (
            <div className="animate-pulse text-[10px] tracking-[0.5em] uppercase opacity-40 text-gold">
              Unfurling the discourse...
            </div>
          )}

          {error && !loading && (
            <div className="border border-gold/20 rounded-sm p-6">
              <div className="text-[10px] tracking-[0.4em] uppercase text-gold mb-2">
                Discourse unavailable
              </div>
              <div className="text-sm font-serif italic opacity-70 mb-4">{error}</div>
              <Link
                href={`/ask?q=${encodeURIComponent(title)}`}
                className="inline-flex items-center gap-2 text-[10px] tracking-[0.4em] uppercase text-gold opacity-70 hover:opacity-100 transition-opacity"
              >
                <MessageCircle size={12} /> Ask Osho about this instead
              </Link>
            </div>
          )}

          {data && !loading && !error && data.paragraphs.length === 0 && (
            <div className="opacity-60 text-sm font-serif italic">
              This discourse has no paragraphs indexed yet.
            </div>
          )}

          {data && !loading && data.paragraphs.length > 0 && (
            <article className="prose-osho font-serif text-base md:text-lg leading-loose space-y-5">
              {data.paragraphs.map((p) => (
                <p key={p.sequence_number} className="whitespace-pre-wrap">
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
