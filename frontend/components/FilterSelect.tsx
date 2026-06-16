'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { ChevronDown } from 'lucide-react';

export interface FilterOption {
  value: string;
  label: string;
  title?: string;
}

interface FilterSelectProps {
  /** Field name shown before the value, e.g. "Match". */
  label: string;
  value: string;
  options: FilterOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}

/**
 * Compact, theme-matched dropdown used for the search filters (Match,
 * Language, Spelling, Sort). Sugit #22/#23: replaces the old inline
 * pipe-separated value lists so each filter reads as one labeled field
 * and the whole row stays compact.
 *
 * Deliberately NOT a native <select> — the gold/ivory aesthetic and the
 * dark-mode tokens don't survive the OS select chrome. It is a custom
 * listbox with full keyboard support instead.
 *
 * IMPORTANT: the search page binds global Arrow keys for match navigation.
 * While the listbox is open its key handler calls stopPropagation() so the
 * arrows move the option highlight rather than jumping between matches.
 */
export function FilterSelect({ label, value, options, onChange, disabled }: FilterSelectProps) {
  const [open, setOpen] = useState(false);
  const [activeIdx, setActiveIdx] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  const selected = options.find((o) => o.value === value) ?? options[0];
  const selectedIdx = Math.max(0, options.findIndex((o) => o.value === value));

  // Close on outside click.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  // When opening, start the highlight on the current value.
  useEffect(() => {
    if (open) setActiveIdx(selectedIdx);
  }, [open, selectedIdx]);

  const choose = useCallback(
    (idx: number) => {
      const opt = options[idx];
      if (opt) onChange(opt.value);
      setOpen(false);
    },
    [options, onChange],
  );

  const onKeyDown = (e: React.KeyboardEvent) => {
    // Don't let the page's global match-nav arrow handler see these while
    // we're driving the listbox.
    if (open) e.stopPropagation();

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        if (!open) setOpen(true);
        else setActiveIdx((i) => Math.min(i + 1, options.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        if (!open) setOpen(true);
        else setActiveIdx((i) => Math.max(i - 1, 0));
        break;
      case 'Home':
        if (open) { e.preventDefault(); setActiveIdx(0); }
        break;
      case 'End':
        if (open) { e.preventDefault(); setActiveIdx(options.length - 1); }
        break;
      case 'Enter':
      case ' ':
        e.preventDefault();
        if (!open) setOpen(true);
        else choose(activeIdx);
        break;
      case 'Escape':
        if (open) { e.preventDefault(); setOpen(false); }
        break;
      case 'Tab':
        setOpen(false);
        break;
    }
  };

  return (
    <div ref={rootRef} className="relative flex items-center gap-2">
      <span className="text-stone-500 dark:text-ivory/60">{label}:</span>
      <button
        type="button"
        disabled={disabled}
        onClick={() => !disabled && setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`${label}: ${selected?.label ?? ''}`}
        title={selected?.title}
        className="inline-flex items-center gap-1 border border-gold/30 rounded-md px-2.5 py-1 text-gold font-medium hover:border-gold/60 focus:border-gold focus:outline-none focus:ring-1 focus:ring-gold/30 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
      >
        <span>{selected?.label}</span>
        <ChevronDown size={14} className={`transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <ul
          ref={listRef}
          role="listbox"
          aria-label={label}
          tabIndex={-1}
          className="absolute top-full left-0 mt-1 z-30 min-w-full whitespace-nowrap rounded-md border border-gold/30 bg-[rgb(var(--bg))] shadow-lg shadow-black/20 py-1"
        >
          {options.map((opt, idx) => {
            const isSel = opt.value === value;
            const isActive = idx === activeIdx;
            return (
              <li
                key={opt.value || 'all'}
                role="option"
                aria-selected={isSel}
                title={opt.title}
                onMouseEnter={() => setActiveIdx(idx)}
                onClick={() => choose(idx)}
                className={`cursor-pointer px-3 py-1.5 ${
                  isActive ? 'bg-gold/10' : ''
                } ${
                  isSel
                    ? 'text-gold font-bold'
                    : 'text-stone-600 dark:text-ivory/70'
                }`}
              >
                {opt.label}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
