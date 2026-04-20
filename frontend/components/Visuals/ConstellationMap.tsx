'use client';

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, ThreeEvent, useFrame, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Stars, Html } from '@react-three/drei';
import * as THREE from 'three';
import type { Lens } from '../Nebula/LensSwitcher';
import type { ParticleSummary } from '../Nebula/ParticlePanel';
import { buildLayout, type ClusterDef, type NebulaNode } from '../../lib/nebulaLayout';

const NEBULA_DATA_URL = '/nebula_data.json';

interface Props {
  lens: Lens;
  highlightedIds: Set<string>;
  focusedCluster: string | null;
  onSelect: (p: ParticleSummary) => void;
  onHover?: (p: ParticleSummary | null) => void;
  onFocusCluster: (name: string | null) => void;
  onClustersChange?: (clusters: ClusterDef[]) => void;
}

function NebulaPoints({
  data,
  lens,
  highlightedIds,
  focusedCluster,
  clusters,
  pointToCluster,
  onSelect,
  onHover,
}: {
  data: NebulaNode[];
  lens: Lens;
  highlightedIds: Set<string>;
  focusedCluster: string | null;
  clusters: ClusterDef[];
  pointToCluster: Uint16Array;
  onSelect: (p: ParticleSummary) => void;
  onHover?: (p: ParticleSummary | null) => void;
}) {
  const pointsRef = useRef<THREE.Points>(null);
  const positionsRef = useRef<Float32Array | null>(null);
  const colorsRef = useRef<Float32Array | null>(null);
  const targetPositionsRef = useRef<Float32Array | null>(null);
  const baseColorsRef = useRef<Float32Array | null>(null);
  const targetColorsRef = useRef<Float32Array | null>(null);

  // Lens / layout changes: reset targets
  useEffect(() => {
    const layout = buildLayout(data, lens);
    if (!positionsRef.current) {
      positionsRef.current = new Float32Array(layout.positions);
      colorsRef.current = new Float32Array(layout.colors);
      baseColorsRef.current = new Float32Array(layout.colors);
      targetPositionsRef.current = layout.positions;
      targetColorsRef.current = layout.colors;
    } else {
      targetPositionsRef.current = layout.positions;
      targetColorsRef.current = layout.colors;
    }
  }, [data, lens]);

  const clusterIndexByName = useMemo(() => {
    const m = new Map<string, number>();
    clusters.forEach((c, i) => m.set(c.name, i));
    return m;
  }, [clusters]);

  const focusedIdx = focusedCluster ? clusterIndexByName.get(focusedCluster) ?? -1 : -1;

  useFrame(({ clock }) => {
    const mesh = pointsRef.current;
    if (!mesh) return;

    const positions = positionsRef.current;
    const colors = colorsRef.current;
    const targetP = targetPositionsRef.current;
    const targetC = targetColorsRef.current;
    const baseC = baseColorsRef.current;
    if (!positions || !colors || !targetP || !targetC || !baseC) return;

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

    const pulse = 0.5 + 0.5 * Math.sin(clock.getElapsedTime() * 3);
    for (let i = 0; i < data.length; i++) {
      const id = data[i].id;
      const ci = i * 3;
      const hl = highlightedIds.has(id);
      const pCluster = pointToCluster[i];
      const dimmed = focusedIdx >= 0 && pCluster !== focusedIdx;
      const boost = hl ? 1.0 + 1.5 * pulse : 1.0;
      const dim = dimmed ? 0.18 : 1.0;
      const base0 = baseC[ci];
      const base1 = baseC[ci + 1];
      const base2 = baseC[ci + 2];
      const targ0 = Math.min(1, base0 * boost * dim);
      const targ1 = Math.min(1, base1 * boost * dim);
      const targ2 = Math.min(1, base2 * boost * dim);
      const blended0 = colors[ci] + (targ0 - colors[ci]) * lerpFactor;
      const blended1 = colors[ci + 1] + (targ1 - colors[ci + 1]) * lerpFactor;
      const blended2 = colors[ci + 2] + (targ2 - colors[ci + 2]) * lerpFactor;
      if (blended0 !== colors[ci] || blended1 !== colors[ci + 1] || blended2 !== colors[ci + 2]) {
        colors[ci] = blended0;
        colors[ci + 1] = blended1;
        colors[ci + 2] = blended2;
        colorsChanged = true;
      }
      baseC[ci]     = baseC[ci]     + (targetC[ci]     - baseC[ci])     * lerpFactor;
      baseC[ci + 1] = baseC[ci + 1] + (targetC[ci + 1] - baseC[ci + 1]) * lerpFactor;
      baseC[ci + 2] = baseC[ci + 2] + (targetC[ci + 2] - baseC[ci + 2]) * lerpFactor;
    }

    const geometry = mesh.geometry as THREE.BufferGeometry;
    if (positionsChanged) {
      (geometry.getAttribute('position') as THREE.BufferAttribute).needsUpdate = true;
    }
    if (colorsChanged) {
      (geometry.getAttribute('color') as THREE.BufferAttribute).needsUpdate = true;
    }

    // Gentle autorotation only when not focused
    if (focusedIdx < 0) {
      mesh.rotation.y = clock.getElapsedTime() * 0.015;
    }
  });

  const geometry = useMemo(() => {
    const geom = new THREE.BufferGeometry();
    const initial = buildLayout(data, lens);
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

function ClusterLabels({
  clusters,
  focusedCluster,
  onFocusCluster,
}: {
  clusters: ClusterDef[];
  focusedCluster: string | null;
  onFocusCluster: (name: string | null) => void;
}) {
  return (
    <>
      {clusters.map((c) => {
        const isFocused = focusedCluster === c.name;
        const isDimmed = focusedCluster !== null && !isFocused;
        return (
          <Html
            key={c.name}
            position={c.centroid}
            center
            distanceFactor={220}
            zIndexRange={[20, 0]}
            style={{ pointerEvents: 'auto' }}
          >
            <button
              onClick={(e) => {
                e.stopPropagation();
                onFocusCluster(isFocused ? null : c.name);
              }}
              className={`whitespace-nowrap select-none transition-all duration-300 ${
                isDimmed ? 'opacity-30 hover:opacity-70' : 'opacity-95'
              }`}
              style={{
                background: 'rgba(0,0,0,0.55)',
                border: `1px solid ${c.color}66`,
                color: c.color,
                padding: '6px 12px',
                borderRadius: 2,
                backdropFilter: 'blur(6px)',
                fontFamily: 'var(--font-sans)',
                fontSize: isFocused ? 11 : 10,
                letterSpacing: '0.3em',
                textTransform: 'uppercase',
                cursor: 'pointer',
              }}
            >
              {c.name}
              <span style={{ opacity: 0.6, marginLeft: 8, fontSize: 9 }}>{c.size}</span>
            </button>
          </Html>
        );
      })}
    </>
  );
}

function CameraController({
  clusters,
  focusedCluster,
}: {
  clusters: ClusterDef[];
  focusedCluster: string | null;
}) {
  const { camera } = useThree();
  const controlsRef = useRef<React.ComponentRef<typeof OrbitControls> | null>(null);
  const targetRef = useRef(new THREE.Vector3(0, 0, 0));
  const desiredPosRef = useRef(new THREE.Vector3(0, 0, 300));

  useEffect(() => {
    if (focusedCluster) {
      const c = clusters.find((x) => x.name === focusedCluster);
      if (c) {
        targetRef.current.set(c.centroid[0], c.centroid[1], c.centroid[2]);
        desiredPosRef.current.set(
          c.centroid[0] + 20,
          c.centroid[1] + 20,
          c.centroid[2] + 110,
        );
        return;
      }
    }
    targetRef.current.set(0, 0, 0);
    desiredPosRef.current.set(0, 0, 300);
  }, [focusedCluster, clusters]);

  useFrame(() => {
    camera.position.lerp(desiredPosRef.current, 0.06);
    const ctrls = controlsRef.current as unknown as { target: THREE.Vector3; update: () => void } | null;
    if (ctrls) {
      ctrls.target.lerp(targetRef.current, 0.08);
      ctrls.update();
    } else {
      camera.lookAt(targetRef.current);
    }
  });

  return (
    <OrbitControls
      ref={controlsRef as React.Ref<React.ComponentRef<typeof OrbitControls>>}
      enablePan
      enableRotate
      zoomSpeed={0.6}
      rotateSpeed={0.5}
      minDistance={30}
      maxDistance={800}
      makeDefault
    />
  );
}

function Scene({
  data,
  lens,
  highlightedIds,
  focusedCluster,
  onSelect,
  onHover,
  onFocusCluster,
  onClustersChange,
}: Props & { data: NebulaNode[] }) {
  const layout = useMemo(() => buildLayout(data, lens), [data, lens]);

  useEffect(() => {
    onClustersChange?.(layout.clusters);
  }, [layout.clusters, onClustersChange]);

  return (
    <>
      <color attach="background" args={['#000000']} />
      <PerspectiveCamera makeDefault position={[0, 0, 300]} fov={50} />
      <CameraController clusters={layout.clusters} focusedCluster={focusedCluster} />
      <ambientLight intensity={0.5} />
      <Stars radius={500} depth={60} count={6000} factor={7} saturation={0} fade speed={1} />
      <NebulaPoints
        data={data}
        lens={lens}
        highlightedIds={highlightedIds}
        focusedCluster={focusedCluster}
        clusters={layout.clusters}
        pointToCluster={layout.pointToCluster}
        onSelect={onSelect}
        onHover={onHover}
      />
      <ClusterLabels
        clusters={layout.clusters}
        focusedCluster={focusedCluster}
        onFocusCluster={onFocusCluster}
      />
      <fog attach="fog" args={['#000000', 180, 900]} />
    </>
  );
}

export default function ConstellationMap({
  lens,
  highlightedIds,
  focusedCluster,
  onSelect,
  onHover,
  onFocusCluster,
  onClustersChange,
}: Props) {
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
        onPointerMissed={() => onFocusCluster(null)}
      >
        {data.length > 0 && (
          <Scene
            data={data}
            lens={lens}
            highlightedIds={highlightedIds}
            focusedCluster={focusedCluster}
            onSelect={onSelect}
            onHover={onHover}
            onFocusCluster={onFocusCluster}
            onClustersChange={onClustersChange}
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
