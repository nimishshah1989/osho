import React, { useRef, useMemo, useState, useEffect } from 'react';
import { Canvas, useFrame, useThree } from '@react-three/fiber';
import { Points, PointMaterial, OrbitControls, Stars, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';

// Note: Ensure nebula_data.json exists in /public/
const NEBULA_DATA_URL = '/nebula_data.json';

interface Node {
  id: string;
  title: string;
  galaxy: string;
  color: string;
  pos: [number, number, number];
  date: string;
}

function NebulaNodes() {
  const [data, setData] = useState<Node[]>([]);
  const pointsRef = useRef<THREE.Points>(null);
  
  useEffect(() => {
    fetch(NEBULA_DATA_URL)
      .then(res => res.json())
      .then(setData)
      .catch(err => console.error("Nebula failed to load:", err));
  }, []);

  const [positions, colors] = useMemo(() => {
    const pos = new Float32Array(data.length * 3);
    const col = new Float32Array(data.length * 3);
    
    data.forEach((node, i) => {
      pos[i * 3] = node.pos[0];
      pos[i * 3 + 1] = node.pos[1];
      pos[i * 3 + 2] = node.pos[2];
      
      const c = new THREE.Color(node.color);
      col[i * 3] = c.r;
      col[i * 3 + 1] = c.g;
      col[i * 3 + 2] = c.b;
    });
    
    return [pos, col];
  }, [data]);

  useFrame((state) => {
    if (pointsRef.current) {
      pointsRef.current.rotation.y = state.clock.getElapsedTime() * 0.02;
    }
  });

  if (data.length === 0) return null;

  return (
    <group>
      <Points ref={pointsRef} positions={positions} colors={colors} stride={3}>
        <PointMaterial
          transparent
          vertexColors
          size={1.8}
          sizeAttenuation={true}
          depthWrite={false}
          blending={THREE.AdditiveBlending}
          opacity={0.8}
        />
      </Points>
    </group>
  );
}

function Scene() {
  return (
    <>
      <color attach="background" args={['#000000']} />
      <PerspectiveCamera makeDefault position={[0, 0, 300]} fov={50} />
      <OrbitControls 
        enablePan={true} 
        enableRotate={true} 
        zoomSpeed={0.5} 
        rotateSpeed={0.5}
        makeDefault
      />
      <ambientLight intensity={0.5} />
      <Stars radius={300} depth={60} count={20000} factor={7} saturation={0} fade speed={1} />
      <NebulaNodes />
      <fog attach="fog" args={['#000000', 100, 800]} />
    </>
  );
}

export default function ConstellationMap() {
  return (
    <div className="fixed inset-0 -z-10 bg-[#000000]">
      <Canvas dpr={[1, 2]}>
        <Scene />
      </Canvas>
      {/* Legend Overlay for Elite Navigation */}
      <div className="absolute top-8 left-8 z-10 hidden md:block opacity-40 hover:opacity-100 transition-opacity">
        <h3 className="text-[10px] tracking-[0.5em] uppercase text-white mb-4">Semantic Galaxies</h3>
        <div className="flex flex-col gap-2">
          {[
            { n: "Zen", c: "#10b981" },
            { n: "Tantra", c: "#ef4444" },
            { n: "Sufism", c: "#8b5cf6" },
            { n: "Meditation", c: "#f59e0b" },
            { n: "Love & Freedom", c: "#ec4899" },
            { n: "Philosophy", c: "#3b82f6" }
          ].map(g => (
            <div key={g.n} className="flex items-center gap-2">
              <div className="w-2 h-2 rounded-full" style={{ background: g.c }} />
              <span className="text-[9px] uppercase tracking-widest text-ivory/80">{g.n}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
