'use client';

import React, { useEffect, useState } from 'react';
import Link from 'next/link';
import { X, MessageCircle } from 'lucide-react';

export interface ParticleSummary {
  id: string;
  title: string;
  galaxy: string;
  date: string;
}

interface ParticleDetail {
  id: number | string;
  content: string;
  event?: {
    title?: string | null;
    date?: string | null;
    location?: string | null;
  };
}

export default function ParticlePanel({
  summary,
  onClose,
}: {
  summary: ParticleSummary | null;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState<ParticleDetail | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!summary) {
      setDetail(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    fetch(`/api/particle/${encodeURIComponent(summary.id)}`)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((data: ParticleDetail) => {
        if (!cancelled) setDetail(data);
      })
      .catch(() => {
        if (!cancelled) setDetail(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [summary]);

  if (!summary) return null;

  const askHref = `/ask?q=${encodeURIComponent(summary.title)}`;

  return (
    <aside
      className="fixed right-0 top-0 h-full w-full md:w-[420px] z-40 bg-black/90 backdrop-blur-md border-l border-gold/10 flex flex-col overflow-hidden"
      role="dialog"
      aria-label="Discourse passage"
    >
      <header className="flex items-start justify-between gap-4 p-6 border-b border-gold/10 pt-20">
        <div>
          <div className="text-[9px] tracking-[0.4em] uppercase text-gold/70 mb-2">
            {summary.galaxy}
          </div>
          <h3 className="text-base md:text-lg font-serif italic text-ivory leading-snug">
            {summary.title}
          </h3>
          <div className="text-[10px] tracking-[0.2em] uppercase opacity-50 mt-2">
            {summary.date}
          </div>
        </div>
        <button
          onClick={onClose}
          aria-label="Close passage panel"
          className="text-ivory/60 hover:text-gold transition-colors"
        >
          <X size={18} />
        </button>
      </header>

      <div className="flex-1 overflow-y-auto custom-scrollbar p-6">
        {loading && (
          <div className="opacity-40 text-[10px] tracking-[0.4em] uppercase">Unfolding…</div>
        )}
        {!loading && detail && (
          <article className="font-serif italic text-sm md:text-base leading-relaxed opacity-85 whitespace-pre-wrap">
            {detail.content}
          </article>
        )}
        {!loading && !detail && (
          <p className="opacity-50 text-sm">
            The passage is not available as a streamable fragment. Use Ask Osho to inquire about this
            discourse.
          </p>
        )}
      </div>

      <footer className="p-6 border-t border-gold/10">
        <Link
          href={askHref}
          className="inline-flex items-center gap-3 text-[10px] tracking-[0.4em] uppercase text-gold hover:text-ivory transition-colors"
        >
          <MessageCircle size={12} /> Ask about this discourse
        </Link>
      </footer>
    </aside>
  );
}
