'use client';

import React, { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { ResponsiveSunburst } from '@nivo/sunburst';
import { ArrowLeft } from 'lucide-react';

type SeriesMap = Record<string, string[]>;
type Hierarchy = Record<string, SeriesMap>;

interface Node {
  id: string;
  name: string;
  kind: 'root' | 'year' | 'series' | 'talk';
  value?: number;
  children?: Node[];
}

const GOLD_PALETTE = [
  '#d4af37',
  '#c19a3a',
  '#b8860b',
  '#e6c45a',
  '#a67c00',
  '#f0d066',
  '#8b6914',
  '#f5d76e',
  '#ba9227',
  '#ffd97a',
];

function isHierarchy(value: unknown): value is Hierarchy {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  for (const [, seriesMap] of Object.entries(value as Record<string, unknown>)) {
    if (!seriesMap || typeof seriesMap !== 'object' || Array.isArray(seriesMap)) return false;
    for (const talks of Object.values(seriesMap as Record<string, unknown>)) {
      if (!Array.isArray(talks) || !talks.every((t) => typeof t === 'string')) return false;
    }
  }
  return true;
}

function sortYears(years: string[]): string[] {
  return [...years].sort((a, b) => {
    const na = /^\d+$/.test(a) ? parseInt(a, 10) : -Infinity;
    const nb = /^\d+$/.test(b) ? parseInt(b, 10) : -Infinity;
    return na - nb;
  });
}

function buildTree(hierarchy: Hierarchy): Node {
  const years = sortYears(Object.keys(hierarchy));
  return {
    id: 'root',
    name: 'Archive',
    kind: 'root',
    children: years.map<Node>((year) => {
      const seriesMap = hierarchy[year];
      const seriesNames = Object.keys(seriesMap).sort();
      return {
        id: `y:${year}`,
        name: year,
        kind: 'year',
        children: seriesNames.map<Node>((series) => {
          const talks = Array.from(new Set(seriesMap[series])).sort();
          return {
            id: `s:${year}:${series}`,
            name: series,
            kind: 'series',
            children: talks.map<Node>((talk) => ({
              id: `t:${year}:${series}:${talk}`,
              name: talk,
              kind: 'talk',
              value: 1,
            })),
          };
        }),
      };
    }),
  };
}

function findSubtree(root: Node, targetId: string): Node | null {
  if (root.id === targetId) return root;
  if (!root.children) return null;
  for (const child of root.children) {
    const hit = findSubtree(child, targetId);
    if (hit) return hit;
  }
  return null;
}

function parentOf(root: Node, targetId: string): Node | null {
  if (!root.children) return null;
  for (const child of root.children) {
    if (child.id === targetId) return root;
    const deeper = parentOf(child, targetId);
    if (deeper) return deeper;
  }
  return null;
}

export default function SunburstExplorer() {
  const router = useRouter();
  const [hierarchy, setHierarchy] = useState<Hierarchy | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string>('root');
  const [hoverLabel, setHoverLabel] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/hierarchy')
      .then(async (res) => {
        const body = await res.json().catch(() => null);
        if (!res.ok) throw new Error((body && body.error) || `Upstream status ${res.status}`);
        return body;
      })
      .then((data: unknown) => {
        if (cancelled) return;
        if (!isHierarchy(data)) {
          setError('The archive returned an unexpected shape.');
          return;
        }
        setHierarchy(data);
      })
      .catch((err: Error) => {
        if (!cancelled) setError(err.message || 'Archive unreachable.');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const fullTree = useMemo(() => (hierarchy ? buildTree(hierarchy) : null), [hierarchy]);
  const focused = useMemo(() => {
    if (!fullTree) return null;
    return findSubtree(fullTree, focusId) ?? fullTree;
  }, [fullTree, focusId]);

  const crumbs = useMemo(() => {
    if (!fullTree) return [] as Node[];
    const trail: Node[] = [];
    let currentId = focusId;
    while (currentId && currentId !== 'root') {
      const node = findSubtree(fullTree, currentId);
      if (!node) break;
      trail.unshift(node);
      const parent = parentOf(fullTree, currentId);
      currentId = parent?.id ?? 'root';
    }
    return trail;
  }, [fullTree, focusId]);

  const handleNodeClick = (node: { id: string | number }) => {
    const id = String(node.id);
    // Nivo prefixes with the parent path using its own separator when nested;
    // our ids are already globally unique so we look them up directly.
    const target = fullTree ? findSubtree(fullTree, id) : null;
    if (!target) return;
    if (target.kind === 'talk') {
      router.push(`/read?title=${encodeURIComponent(target.name)}`);
      return;
    }
    if (target.children && target.children.length > 0) {
      setFocusId(target.id);
    }
  };

  const goUp = () => {
    if (!fullTree) return;
    const parent = parentOf(fullTree, focusId);
    setFocusId(parent?.id ?? 'root');
  };

  return (
    <main className="min-h-screen bg-black text-ivory/85 selection:bg-gold/30 flex flex-col">
      <div className="pt-28 md:pt-32 px-6 md:px-10 pb-4">
        <h1 className="text-xs tracking-[0.6em] uppercase text-gold/80 mb-2">The Nebula</h1>
        <p className="text-[11px] tracking-[0.2em] uppercase opacity-40">
          Click a year or series to drill in · click a talk to read it
        </p>
      </div>

      <div className="px-6 md:px-10 flex items-center gap-3 text-[10px] tracking-[0.3em] uppercase opacity-60 mb-2 min-h-[24px]">
        {focusId !== 'root' && (
          <button
            onClick={goUp}
            className="flex items-center gap-2 text-gold hover:opacity-100 opacity-80 transition-opacity"
          >
            <ArrowLeft size={12} /> Up
          </button>
        )}
        <button
          onClick={() => setFocusId('root')}
          className={focusId === 'root' ? 'text-gold' : 'hover:opacity-100 opacity-60 transition-opacity'}
        >
          Archive
        </button>
        {crumbs.map((c) => (
          <React.Fragment key={c.id}>
            <span className="opacity-30">/</span>
            <button
              onClick={() => setFocusId(c.id)}
              className={c.id === focusId ? 'text-gold' : 'hover:opacity-100 opacity-60 transition-opacity'}
            >
              {c.name}
            </button>
          </React.Fragment>
        ))}
      </div>

      <div className="flex-1 relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center text-[10px] tracking-[0.5em] uppercase text-gold/70 animate-pulse">
            Unfolding the Nebula...
          </div>
        )}
        {error && !loading && (
          <div className="absolute inset-0 flex items-center justify-center">
            <div className="border border-gold/20 rounded-sm p-6 max-w-md">
              <div className="text-[10px] tracking-[0.4em] uppercase text-gold mb-2">Nebula Unavailable</div>
              <div className="text-sm font-serif italic opacity-70">{error}</div>
            </div>
          </div>
        )}
        {focused && !loading && !error && (
          <div className="absolute inset-0">
            <ResponsiveSunburst
              data={focused}
              id="id"
              value="value"
              cornerRadius={2}
              borderWidth={1}
              borderColor="#000000"
              colors={GOLD_PALETTE}
              childColor={{ from: 'color', modifiers: [['brighter', 0.1]] }}
              enableArcLabels={false}
              animate
              motionConfig="gentle"
              onClick={handleNodeClick}
              onMouseEnter={(node) => {
                const target = fullTree ? findSubtree(fullTree, String(node.id)) : null;
                setHoverLabel(target?.name ?? null);
              }}
              onMouseLeave={() => setHoverLabel(null)}
              tooltip={(node) => {
                const target = fullTree ? findSubtree(fullTree, String(node.id)) : null;
                const label = target?.name ?? String(node.id);
                const hint =
                  target?.kind === 'talk'
                    ? 'Click to read'
                    : target?.kind === 'root'
                      ? null
                      : 'Click to zoom in';
                return (
                  <div className="bg-black/90 border border-gold/30 rounded-sm px-3 py-2 text-xs">
                    <div className="font-serif italic text-ivory">{label}</div>
                    {hint && (
                      <div className="text-[9px] tracking-[0.3em] uppercase text-gold/70 mt-1">
                        {hint}
                      </div>
                    )}
                  </div>
                );
              }}
            />
            {hoverLabel && (
              <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                <div className="text-center max-w-md px-6">
                  <div className="font-serif italic text-ivory text-lg md:text-xl opacity-90">
                    {hoverLabel}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </main>
  );
}
