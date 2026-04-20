'use client';

import React from 'react';
import { Layers, Clock, MapPin, Sparkles, type LucideIcon } from 'lucide-react';

export type Lens = 'themes' | 'timeline' | 'geography' | 'concepts';

const LENSES: { id: Lens; label: string; Icon: LucideIcon }[] = [
  { id: 'themes',    label: 'Themes',    Icon: Layers },
  { id: 'timeline',  label: 'Timeline',  Icon: Clock },
  { id: 'geography', label: 'Geography', Icon: MapPin },
  { id: 'concepts',  label: 'Concepts',  Icon: Sparkles },
];

export default function LensSwitcher({
  active,
  onChange,
}: {
  active: Lens;
  onChange: (lens: Lens) => void;
}) {
  return (
    <div className="fixed top-20 right-4 md:right-8 z-40 flex flex-col gap-2 backdrop-blur-md bg-black/40 border border-gold/10 p-2 rounded-sm">
      {LENSES.map(({ id, label, Icon }) => (
        <button
          key={id}
          onClick={() => onChange(id)}
          aria-pressed={active === id}
          className={`flex items-center gap-3 px-3 py-2 text-[9px] tracking-[0.3em] uppercase transition-all ${
            active === id ? 'text-gold' : 'text-ivory/50 hover:text-ivory'
          }`}
        >
          <Icon size={12} />
          <span className="hidden md:inline">{label}</span>
        </button>
      ))}
    </div>
  );
}
