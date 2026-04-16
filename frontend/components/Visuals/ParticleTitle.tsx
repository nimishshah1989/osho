'use client';

import React, { useRef, useEffect, useMemo } from 'react';

const PARTICLE_COUNT = 8000;
const SPEED = 0.08;
const REPEL_RADIUS = 80;
const REPEL_STRENGTH = 1.2;
const MOUSE_STRENGTH = 0.1;

export default function ParticleTitle({ text = "OSHO SPEAKS.." }: { text?: string }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const mouse = useRef({ x: -1000, y: -1000 });

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    let animationFrame: number;
    let w = canvas.width = window.innerWidth;
    let h = canvas.height = window.innerHeight;

    // Use a hidden canvas to sample the text pixels
    const sampleCanvas = document.createElement('canvas');
    const sCtx = sampleCanvas.getContext('2d')!;
    sampleCanvas.width = 1200;
    sampleCanvas.height = 400;

    // Drawing settings for sampling
    const getTargetPoints = (txt: string) => {
      sCtx.clearRect(0, 0, sampleCanvas.width, sampleCanvas.height);
      sCtx.fillStyle = '#white';
      sCtx.font = 'bold 120px serif';
      sCtx.textAlign = 'center';
      sCtx.textBaseline = 'middle';
      sCtx.letterSpacing = '12px';
      sCtx.fillText(txt, sampleCanvas.width / 2, sampleCanvas.height / 2);

      const data = sCtx.getImageData(0, 0, sampleCanvas.width, sampleCanvas.height).data;
      const points: { x: number, y: number }[] = [];
      const step = 4; // Sample every Nth pixel for density

      for (let y = 0; y < sampleCanvas.height; y += step) {
        for (let x = 0; x < sampleCanvas.width; x += step) {
          const alpha = data[(y * sampleCanvas.width + x) * 4 + 3];
          if (alpha > 128) {
            points.push({
              x: (x - sampleCanvas.width / 2) + w / 2,
              y: (y - sampleCanvas.height / 2) + h / 2 - 40 // Adjusted position
            });
          }
        }
      }
      return points;
    };

    const targets = getTargetPoints(text);
    
    // Initial particle state (randomly spread like a nebula)
    const px = new Float32Array(PARTICLE_COUNT);
    const py = new Float32Array(PARTICLE_COUNT);
    const vx = new Float32Array(PARTICLE_COUNT);
    const vy = new Float32Array(PARTICLE_COUNT);
    const tx = new Float32Array(PARTICLE_COUNT);
    const ty = new Float32Array(PARTICLE_COUNT);

    for (let i = 0; i < PARTICLE_COUNT; i++) {
        px[i] = Math.random() * w;
        py[i] = Math.random() * h;
        vx[i] = (Math.random() - 0.5) * 2;
        vy[i] = (Math.random() - 0.5) * 2;
        
        // Loop targeting
        const target = targets[i % targets.length];
        tx[i] = target.x;
        ty[i] = target.y;
    }

    const animate = () => {
      ctx.clearRect(0, 0, w, h);
      
      // Draw Particles
      // Use a subtle glow effect
      ctx.fillStyle = '#d4af37'; // Gold
      
      for (let i = 0; i < PARTICLE_COUNT; i++) {
        const dx = tx[i] - px[i];
        const dy = ty[i] - py[i];
        
        // Physics: Spring to target
        vx[i] += dx * SPEED;
        vy[i] += dy * SPEED;
        vx[i] *= 0.85; // Friction
        vy[i] *= 0.85;

        // Interaction: Mouse Repulsion
        const mdx = px[i] - mouse.current.x;
        const mdy = py[i] - mouse.current.y;
        const mDist = Math.sqrt(mdx * mdx + mdy * mdy);
        if (mDist < REPEL_RADIUS) {
            const force = (REPEL_RADIUS - mDist) / REPEL_RADIUS;
            vx[i] += (mdx / mDist) * force * REPEL_STRENGTH;
            vy[i] += (mdy / mDist) * force * REPEL_STRENGTH;
        }

        px[i] += vx[i];
        py[i] += vy[i];

        // Rendering: Draw tiny rectangles or arcs
        if (i % 2 === 0) {
            ctx.globalAlpha = 0.6;
            ctx.fillRect(px[i], py[i], 1.2, 1.2);
        } else {
            ctx.globalAlpha = 0.2;
            ctx.fillRect(px[i], py[i], 1, 1);
        }
      }

      animationFrame = requestAnimationFrame(animate);
    };

    const handleMouseMove = (e: MouseEvent) => {
        mouse.current.x = e.clientX;
        mouse.current.y = e.clientY;
    };

    const handleResize = () => {
        w = canvas.width = window.innerWidth;
        h = canvas.height = window.innerHeight;
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('resize', handleResize);
    animate();

    return () => {
      cancelAnimationFrame(animationFrame);
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('resize', handleResize);
    };
  }, [text]);

  return (
    <canvas 
      ref={canvasRef} 
      className="absolute inset-0 pointer-events-none z-10"
      style={{ filter: 'blur(0.4px)' }}
    />
  );
}
