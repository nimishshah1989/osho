'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, ThreeEvent, useFrame } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Stars } from '@react-three/drei';
import * as THREE from 'three';
import type { Lens } from '../Nebula/LensSwitcher';
import type { ParticleSummary } from '../Nebula/ParticlePanel';

const NEBULA_DATA_URL = '/nebula_data.json';

interface NebulaNode {
  id: string;
  title: string;
  galaxy: string;
  color: string;
  pos: [number, number, number];
  date: string;
}

interface Props {
  lens: Lens;
  highlightedIds: Set<string>;
  onSelect: (p: ParticleSummary) => void;
  onHover?: (p: ParticleSummary | null) => void;
}

const ERA_COLORS: Record<string, string> = {
  Bombay: '#60a5fa',
  'Poona I': '#d4af37',
  Rajneeshpuram: '#ef4444',
  'Poona II': '#10b981',
  Unknown: '#94a3b8',
};

function eraFor(date: string): string {
  const yr = parseInt((date || '').slice(0, 4), 10);
  if (!Number.isFinite(yr)) return 'Unknown';
  if (yr < 1970) return 'Bombay';
  if (yr < 1981) return 'Poona I';
  if (yr < 1986) return 'Rajneeshpuram';
  return 'Poona II';
}

function hash(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return h;
}

function jitter(id: string, seed: number): number {
  const h = Math.abs(hash(id + ':' + seed));
  return ((h % 1000) / 1000 - 0.5) * 2;
}

function buildLensGeometry(data: NebulaNode[], lens: Lens): { positions: Float32Array; colors: Float32Array } {
  const positions = new Float32Array(data.length * 3);
  const colors = new Float32Array(data.length * 3);
  const c = new THREE.Color();

  data.forEach((node, i) => {
    let x = node.pos[0];
    let y = node.pos[1];
    let z = node.pos[2];
    let colorHex = node.color;

    if (lens === 'timeline') {
      const year = parseInt((node.date || '').slice(0, 4), 10);
      const y0 = Number.isFinite(year) ? year : 1976;
      x = (y0 - 1975) * 14 + jitter(node.id, 1) * 12;
      y = jitter(node.id, 2) * 80;
      z = jitter(node.id, 3) * 60;
      colorHex = ERA_COLORS[eraFor(node.date)] ?? '#94a3b8';
    } else if (lens === 'geography') {
      // No location in client data — lay out clusters in horizontal bands by galaxy
      const galaxyIndex = Math.abs(hash(node.galaxy)) % 7;
      const radius = 80 + galaxyIndex * 22;
      const angle = (hash(node.id) % 360) * (Math.PI / 180);
      x = Math.cos(angle) * radius + jitter(node.id, 4) * 10;
      y = (galaxyIndex - 3) * 40 + jitter(node.id, 5) * 12;
      z = Math.sin(angle) * radius + jitter(node.id, 6) * 10;
    } else if (lens === 'concepts') {
      // Spread original positions outward; color by decade
      x = node.pos[0] * 1.3;
      y = node.pos[1] * 1.3;
      z = node.pos[2] * 1.3;
      const decade = Math.floor((parseInt((node.date || '').slice(0, 4), 10) || 1970) / 10) * 10;
      const hueSeed = (decade - 1940) * 0.08;
      c.setHSL((hueSeed % 1 + 1) % 1, 0.6, 0.55);
      colorHex = '#' + c.getHexString();
    }
    // themes: defaults already set

    positions[i * 3] = x;
    positions[i * 3 + 1] = y;
    positions[i * 3 + 2] = z;

    c.set(colorHex);
    colors[i * 3] = c.r;
    colors[i * 3 + 1] = c.g;
    colors[i * 3 + 2] = c.b;
  });

  return { positions, colors };
}

function NebulaPoints({ data, lens, highlightedIds, onSelect, onHover }: {
  data: NebulaNode[];
  lens: Lens;
  highlightedIds: Set<string>;
  onSelect: (p: ParticleSummary) => void;
  onHover?: (p: ParticleSummary | null) => void;
}) {
  const pointsRef = useRef<THREE.Points>(null);
  const positionsRef = useRef<Float32Array | null>(null);
  const colorsRef = useRef<Float32Array | null>(null);
  const targetPositionsRef = useRef<Float32Array | null>(null);
  const baseColorsRef = useRef<Float32Array | null>(null);
  const targetColorsRef = useRef<Float32Array | null>(null);

  useEffect(() => {
    const geom = buildLensGeometry(data, lens);
    if (!positionsRef.current) {
      positionsRef.current = new Float32Array(geom.positions);
      colorsRef.current = new Float32Array(geom.colors);
      baseColorsRef.current = new Float32Array(geom.colors);
      targetPositionsRef.current = geom.positions;
      targetColorsRef.current = geom.colors;
    } else {
      targetPositionsRef.current = geom.positions;
      targetColorsRef.current = geom.colors;
      baseColorsRef.current = new Float32Array(geom.colors);
    }
  }, [data, lens]);

  useFrame(({ clock }) => {
    const mesh = pointsRef.current;
    if (!mesh) return;

    const positions = positionsRef.current;
    const colors = colorsRef.current;
    const targetP = targetPositionsRef.current;
    const targetC = targetColorsRef.current;
    const baseC = baseColorsRef.current;
    if (!positions || !colors || !targetP || !targetC || !baseC) return;

    // Smooth position + color transition
    const lerpFactor = 0.08;
    let positionsChanged = false;
    let colorsChanged = false;

    for (let i = 0; i < positions.length; i++) {
      const diff = targetP[i] - positions[i];
      if (Math.abs(diff) > 0.01) {
        positions[i] += diff * lerpFactor;
        positionsChanged = true;
      } else if (positions[i] !== targetP[i]) {
        positions[i] = targetP[i];
        positionsChanged = true;
      }
    }

    // Highlight pulse: boost brightness of highlighted ids
    const pulse = 0.5 + 0.5 * Math.sin(clock.getElapsedTime() * 3);
    for (let i = 0; i < data.length; i++) {
      const id = data[i].id;
      const ci = i * 3;
      const hl = highlightedIds.has(id);
      const boost = hl ? 1.0 + 1.5 * pulse : 1.0;
      const base0 = baseC[ci];
      const base1 = baseC[ci + 1];
      const base2 = baseC[ci + 2];
      const targ0 = Math.min(1, base0 * boost);
      const targ1 = Math.min(1, base1 * boost);
      const targ2 = Math.min(1, base2 * boost);
      // Also blend toward target color on lens switch
      const blended0 = colors[ci] + (targ0 - colors[ci]) * lerpFactor;
      const blended1 = colors[ci + 1] + (targ1 - colors[ci + 1]) * lerpFactor;
      const blended2 = colors[ci + 2] + (targ2 - colors[ci + 2]) * lerpFactor;
      if (blended0 !== colors[ci] || blended1 !== colors[ci + 1] || blended2 !== colors[ci + 2]) {
        colors[ci] = blended0;
        colors[ci + 1] = blended1;
        colors[ci + 2] = blended2;
        colorsChanged = true;
      }
      // Keep base in sync with lens-target base (no highlight)
      baseC[ci] = baseC[ci] + (targetC[ci] - baseC[ci]) * lerpFactor;
      baseC[ci + 1] = baseC[ci + 1] + (targetC[ci + 1] - baseC[ci + 1]) * lerpFactor;
      baseC[ci + 2] = baseC[ci + 2] + (targetC[ci + 2] - baseC[ci + 2]) * lerpFactor;
    }

    const geometry = mesh.geometry as THREE.BufferGeometry;
    if (positionsChanged) {
      const attr = geometry.getAttribute('position') as THREE.BufferAttribute;
      attr.needsUpdate = true;
    }
    if (colorsChanged) {
      const attr = geometry.getAttribute('color') as THREE.BufferAttribute;
      attr.needsUpdate = true;
    }

    // Gentle autorotation
    mesh.rotation.y = clock.getElapsedTime() * 0.015;
  });

  const geometry = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    const initial = buildLensGeometry(data, lens);
    geom.setAttribute('position', new THREE.BufferAttribute(initial.positions, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(initial.colors, 3));
    positionsRef.current = new Float32Array(initial.positions);
    colorsRef.current = new Float32Array(initial.colors);
    baseColorsRef.current = new Float32Array(initial.colors);
    targetPositionsRef.current = initial.positions;
    targetColorsRef.current = initial.colors;
    return geom;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data.length]);

  const handleClick = (e: ThreeEvent<MouseEvent>) => {
    const idx = e.index;
    if (idx === undefined) return;
    const node = data[idx];
    if (node) {
      e.stopPropagation();
      onSelect({ id: node.id, title: node.title, galaxy: node.galaxy, date: node.date });
    }
  };

  const handlePointerOver = (e: ThreeEvent<PointerEvent>) => {
    const idx = e.index;
    if (idx === undefined) return;
    const node = data[idx];
    if (node && onHover) {
      onHover({ id: node.id, title: node.title, galaxy: node.galaxy, date: node.date });
    }
  };

  const handlePointerOut = () => {
    onHover?.(null);
  };

  return (
    <points
      ref={pointsRef}
      geometry={geometry}
      onClick={handleClick}
      onPointerOver={handlePointerOver}
      onPointerOut={handlePointerOut}
    >
      <pointsMaterial
        vertexColors
        transparent
        size={1.8}
        sizeAttenuation
        depthWrite={false}
        blending={THREE.AdditiveBlending}
        opacity={0.85}
      />
    </points>
  );
}

function Scene({ data, lens, highlightedIds, onSelect, onHover }: Props & { data: NebulaNode[] }) {
  return (
    <>
      <color attach="background" args={['#000000']} />
      <PerspectiveCamera makeDefault position={[0, 0, 300]} fov={50} />
      <OrbitControls
        enablePan
        enableRotate
        zoomSpeed={0.6}
        rotateSpeed={0.5}
        minDistance={40}
        maxDistance={800}
        makeDefault
      />
      <ambientLight intensity={0.5} />
      <Stars radius={500} depth={60} count={8000} factor={7} saturation={0} fade speed={1} />
      <NebulaPoints
        data={data}
        lens={lens}
        highlightedIds={highlightedIds}
        onSelect={onSelect}
        onHover={onHover}
      />
      <fog attach="fog" args={['#000000', 120, 900]} />
    </>
  );
}

export default function ConstellationMap({ lens, highlightedIds, onSelect, onHover }: Props) {
  const [data, setData] = useState<NebulaNode[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch(NEBULA_DATA_URL)
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`status ${r.status}`))))
      .then((d: NebulaNode[]) => {
        if (!cancelled) setData(d);
      })
      .catch((err: Error) => {
        if (!cancelled) setLoadError(err.message);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="fixed inset-0 -z-10 bg-black">
      <Canvas
        dpr={[1, 2]}
        onCreated={({ raycaster }) => {
          raycaster.params.Points = { threshold: 2.5 };
        }}
      >
        {data.length > 0 && (
          <Scene
            data={data}
            lens={lens}
            highlightedIds={highlightedIds}
            onSelect={onSelect}
            onHover={onHover}
          />
        )}
      </Canvas>
      {data.length === 0 && !loadError && (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] tracking-[0.5em] uppercase opacity-40">
          Igniting the nebula…
        </div>
      )}
      {loadError && (
        <div className="absolute inset-0 flex items-center justify-center text-[10px] tracking-[0.4em] uppercase opacity-50 text-gold/80">
          Nebula failed to load. The stillness remains undisturbed.
        </div>
      )}
    </div>
  );
}
