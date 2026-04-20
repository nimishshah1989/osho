'use client';

import React, { useEffect, useMemo, useState, Suspense } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import Nav from '../Nav';
import LensSwitcher, { Lens } from './LensSwitcher';
import ParticlePanel, { ParticleSummary } from './ParticlePanel';

const ConstellationMap = dynamic(() => import('../Visuals/ConstellationMap'), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 flex items-center justify-center bg-black text-ivory/50 text-[10px] tracking-[0.5em] uppercase">
      Loading the cosmos…
    </div>
  ),
});

function NebulaInner() {
  const searchParams = useSearchParams();
  const [lens, setLens] = useState<Lens>('themes');
  const [hovered, setHovered] = useState<ParticleSummary | null>(null);
  const [selected, setSelected] = useState<ParticleSummary | null>(null);

  const highlightedIds = useMemo(() => {
    const raw = searchParams?.get('highlight') ?? '';
    if (!raw) return new Set<string>();
    return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  }, [searchParams]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setSelected(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <Nav />
      <ConstellationMap
        lens={lens}
        highlightedIds={highlightedIds}
        onSelect={setSelected}
        onHover={setHovered}
      />
      <LensSwitcher active={lens} onChange={setLens} />
      <ParticlePanel summary={selected} onClose={() => setSelected(null)} />

      {/* Legend + hover tooltip */}
      <div className="fixed top-20 left-4 md:left-8 z-30 pointer-events-none">
        <h3 className="text-[10px] tracking-[0.5em] uppercase text-ivory/70 mb-3">
          {lens === 'themes'    && 'Semantic Galaxies'}
          {lens === 'timeline'  && 'Era'}
          {lens === 'geography' && 'Galactic Bands'}
          {lens === 'concepts'  && 'By Decade'}
        </h3>
        <Legend lens={lens} />
      </div>

      {hovered && !selected && (
        <div
          className="fixed bottom-8 left-1/2 -translate-x-1/2 z-30 pointer-events-none text-center max-w-md px-6 py-3 bg-black/70 backdrop-blur-md border border-gold/10 rounded-sm"
          role="status"
        >
          <div className="text-[9px] tracking-[0.4em] uppercase text-gold/70 mb-1">{hovered.galaxy}</div>
          <div className="font-serif italic text-sm md:text-base text-ivory">{hovered.title}</div>
          <div className="text-[9px] tracking-[0.2em] uppercase opacity-50 mt-1">{hovered.date}</div>
        </div>
      )}

      {highlightedIds.size > 0 && (
        <div className="fixed bottom-8 right-8 z-30 pointer-events-none text-[9px] tracking-[0.4em] uppercase opacity-60">
          {highlightedIds.size} passages illumined
        </div>
      )}
    </>
  );
}

function Legend({ lens }: { lens: Lens }) {
  const items =
    lens === 'themes'
      ? [
          { n: 'Zen', c: '#10b981' },
          { n: 'Tantra', c: '#ef4444' },
          { n: 'Sufism', c: '#8b5cf6' },
          { n: 'Meditation', c: '#f59e0b' },
          { n: 'Love & Freedom', c: '#ec4899' },
          { n: 'Philosophy', c: '#3b82f6' },
        ]
      : lens === 'timeline'
      ? [
          { n: 'Bombay 60s', c: '#60a5fa' },
          { n: 'Poona I 70s', c: '#d4af37' },
          { n: 'Rajneeshpuram 80s', c: '#ef4444' },
          { n: 'Poona II late 80s', c: '#10b981' },
        ]
      : lens === 'concepts'
      ? [
          { n: '1960s', c: '#3b82f6' },
          { n: '1970s', c: '#f59e0b' },
          { n: '1980s', c: '#ef4444' },
          { n: '1990s', c: '#10b981' },
        ]
      : [
          { n: 'Galactic band', c: '#d4af37' },
          { n: 'radius grouping', c: '#94a3b8' },
        ];

  return (
    <div className="flex flex-col gap-2">
      {items.map((g) => (
        <div key={g.n} className="flex items-center gap-2">
          <div className="w-2 h-2 rounded-full" style={{ background: g.c }} />
          <span className="text-[9px] uppercase tracking-widest text-ivory/70">{g.n}</span>
        </div>
      ))}
    </div>
  );
}

export default function NebulaExperience() {
  return (
    <Suspense fallback={null}>
      <NebulaInner />
    </Suspense>
  );
}
