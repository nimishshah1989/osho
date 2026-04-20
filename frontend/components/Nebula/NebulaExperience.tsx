'use client';

import React, { useEffect, useMemo, useState, Suspense } from 'react';
import dynamic from 'next/dynamic';
import { useSearchParams } from 'next/navigation';
import Nav from '../Nav';
import LensSwitcher, { Lens } from './LensSwitcher';
import ParticlePanel, { ParticleSummary } from './ParticlePanel';
import type { ClusterDef } from '../../lib/nebulaLayout';

const ConstellationMap = dynamic(() => import('../Visuals/ConstellationMap'), {
  ssr: false,
  loading: () => (
    <div className="fixed inset-0 flex items-center justify-center bg-black text-ivory/50 text-[10px] tracking-[0.5em] uppercase">
      Loading the cosmos…
    </div>
  ),
});

const LENS_TITLE: Record<Lens, string> = {
  themes: 'Semantic Galaxies',
  timeline: 'Era',
  geography: 'Galactic Bands',
  concepts: 'By Decade',
};

function NebulaInner() {
  const searchParams = useSearchParams();
  const [lens, setLens] = useState<Lens>('themes');
  const [hovered, setHovered] = useState<ParticleSummary | null>(null);
  const [selected, setSelected] = useState<ParticleSummary | null>(null);
  const [focusedCluster, setFocusedCluster] = useState<string | null>(null);
  const [clusters, setClusters] = useState<ClusterDef[]>([]);

  const highlightedIds = useMemo(() => {
    const raw = searchParams?.get('highlight') ?? '';
    if (!raw) return new Set<string>();
    return new Set(raw.split(',').map((s) => s.trim()).filter(Boolean));
  }, [searchParams]);

  // Clear focus on lens change so users aren't stuck zoomed on a stale cluster
  useEffect(() => {
    setFocusedCluster(null);
  }, [lens]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (selected) setSelected(null);
        else if (focusedCluster) setFocusedCluster(null);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selected, focusedCluster]);

  return (
    <>
      <Nav />
      <ConstellationMap
        lens={lens}
        highlightedIds={highlightedIds}
        focusedCluster={focusedCluster}
        onSelect={setSelected}
        onHover={setHovered}
        onFocusCluster={setFocusedCluster}
        onClustersChange={setClusters}
      />
      <LensSwitcher active={lens} onChange={setLens} />
      <ParticlePanel summary={selected} onClose={() => setSelected(null)} />

      {/* Cluster palette / focus panel */}
      <div className="fixed top-20 left-4 md:left-8 z-30 max-w-[220px]">
        <h3 className="text-[10px] tracking-[0.5em] uppercase text-ivory/70 mb-3">
          {LENS_TITLE[lens]}
        </h3>
        <div className="flex flex-col gap-1.5">
          {clusters.map((c) => {
            const active = focusedCluster === c.name;
            return (
              <button
                key={c.name}
                onClick={() =>
                  setFocusedCluster(active ? null : c.name)
                }
                aria-pressed={active}
                className={`flex items-center gap-2 px-2 py-1.5 rounded-sm text-left transition-all ${
                  active
                    ? 'bg-gold/10 border border-gold/30'
                    : 'hover:bg-ivory/5 border border-transparent'
                }`}
              >
                <span
                  className="w-2 h-2 rounded-full shrink-0"
                  style={{ background: c.color }}
                />
                <span
                  className={`text-[9px] uppercase tracking-widest truncate ${
                    active ? 'text-gold' : 'text-ivory/70'
                  }`}
                >
                  {c.name}
                </span>
                <span className="ml-auto text-[9px] opacity-40">{c.size}</span>
              </button>
            );
          })}
        </div>
        {focusedCluster && (
          <button
            onClick={() => setFocusedCluster(null)}
            className="mt-3 text-[9px] tracking-[0.3em] uppercase text-ivory/50 hover:text-ivory"
          >
            ← Back to all
          </button>
        )}
      </div>

      {/* Interaction hint */}
      {!hovered && !selected && !focusedCluster && clusters.length > 0 && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-30 pointer-events-none text-center">
          <div className="text-[9px] tracking-[0.4em] uppercase text-ivory/50">
            Click a label or list entry to zoom into a cluster · drag to orbit · scroll to zoom
          </div>
        </div>
      )}
      {!hovered && !selected && focusedCluster && (
        <div className="fixed bottom-8 left-1/2 -translate-x-1/2 z-30 pointer-events-none text-center">
          <div className="text-[9px] tracking-[0.4em] uppercase text-gold/80">
            Click any star to read the discourse · ESC to return
          </div>
        </div>
      )}

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

export default function NebulaExperience() {
  return (
    <Suspense fallback={null}>
      <NebulaInner />
    </Suspense>
  );
}
