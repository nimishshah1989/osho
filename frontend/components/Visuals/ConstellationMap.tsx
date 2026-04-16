'use client';

import React, { useRef, useMemo } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Points, PointMaterial, Float, Line } from '@react-three/drei';
import * as THREE from 'three';

// Constellation Galaxy Centers (Mapped to the 11 topics)
const GALAXIES = [
  { name: "Meditation", color: "#d4af37", pos: [100, 0, 0] },
  { name: "Zen", color: "#ffffff", pos: [0, 100, 0] },
  { name: "Taoism", color: "#4169e1", pos: [-100, 0, 0] },
  { name: "Sufism", color: "#ffd700", pos: [0, -100, 0] },
  { name: "Silence", color: "#ivory", pos: [0, 0, 100] },
  { name: "Awareness", color: "#d4af37", pos: [0, 0, -100] }
];

function Galaxy({ center, color, count = 200 }: any) {
  const points = useMemo(() => {
    const p = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
      const r = Math.random() * 50;
      const theta = Math.random() * Math.PI * 2;
      const phi = Math.acos(2 * Math.random() - 1);
      p[i * 3] = center[0] + r * Math.sin(phi) * Math.cos(theta);
      p[i * 3 + 1] = center[1] + r * Math.sin(phi) * Math.sin(theta);
      p[i * 3 + 2] = center[2] + r * Math.cos(phi);
    }
    return p;
  }, [center, count]);

  return (
    <group>
      <Points positions={points} stride={3}>
        <PointMaterial
          transparent
          color={color}
          size={0.5}
          sizeAttenuation={true}
          depthWrite={false}
          opacity={0.4}
        />
      </Points>
      {/* Network Lines for the Galaxy */}
      {Array.from({ length: 15 }).map((_, i) => {
        const startIdx = Math.floor(Math.random() * count);
        const endIdx = Math.floor(Math.random() * count);
        return (
          <Line
            key={i}
            points={[
              [points[startIdx * 3], points[startIdx * 3 + 1], points[startIdx * 3 + 2]],
              [points[endIdx * 3], points[endIdx * 3 + 1], points[endIdx * 3 + 2]]
            ]}
            color={color}
            lineWidth={0.2}
            transparent
            opacity={0.15}
          />
        );
      })}
    </group>
  );
}

function Scene() {
  const group = useRef<THREE.Group>(null);
  
  useFrame((state) => {
    if (group.current) {
      group.current.rotation.y = state.clock.getElapsedTime() * 0.05;
      group.current.rotation.x = Math.sin(state.clock.getElapsedTime() * 0.03) * 0.1;
    }
  });

  return (
    <group ref={group}>
      {GALAXIES.map((g, i) => (
        <Galaxy key={i} center={g.pos} color={g.color} />
      ))}
      {/* Background Dust */}
      <Points positions={new Float32Array(Array.from({ length: 3000 }, () => (Math.random() - 0.5) * 800))}>
        <PointMaterial
          transparent
          color="#ffffff"
          size={0.2}
          sizeAttenuation={true}
          depthWrite={false}
          opacity={0.1}
        />
      </Points>
    </group>
  );
}

export default function ConstellationMap() {
  return (
    <div className="fixed inset-0 -z-10 bg-[#000000]">
      <Canvas camera={{ position: [0, 0, 250], fov: 60 }}>
        <fog attach="fog" args={['#000000', 100, 500]} />
        <Scene />
      </Canvas>
    </div>
  );
}
