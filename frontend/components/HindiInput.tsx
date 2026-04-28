'use client';

import React, {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
} from 'react';
import { romanToDevanagari, expandAnusvara } from '../lib/transliterate';

interface HindiInputProps {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  ariaLabel?: string;
}

export interface HindiInputHandle {
  focus: () => void;
}

/**
 * Hindi transliteration input — Quillpad / Google Input Tools style.
 *
 * Behavior:
 * - User types Roman characters in the input field
 * - A floating suggestion panel shows candidate Devanagari conversions
 * - On Space: top suggestion replaces the Roman word in-place
 * - On number key (1-5): selects that numbered suggestion
 * - On Escape: dismisses suggestions and keeps Roman text
 * - On Enter: submits the form (converting any pending Roman word first)
 * - Already-converted Devanagari words stay in the input
 * - Backspace works normally; deleting into a converted word keeps it as-is
 */
const HindiInput = forwardRef<HindiInputHandle, HindiInputProps>(
  ({ value, onChange, onSubmit, placeholder, className, disabled, autoFocus, ariaLabel }, ref) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [selectedSuggestion, setSelectedSuggestion] = useState(0);

    useImperativeHandle(ref, () => ({
      focus: () => inputRef.current?.focus(),
    }));

    // Extract the last word being typed (if it's Roman)
    const lastRomanWord = useMemo(() => {
      const parts = value.split(/\s/);
      const last = parts[parts.length - 1] || '';
      if (/[a-zA-Z]/.test(last) && last.length > 0) return last;
      return '';
    }, [value]);

    // Generate suggestions for the current Roman word
    const suggestions = useMemo(() => {
      if (!lastRomanWord) return [];
      const primary = romanToDevanagari(lastRomanWord);
      if (!primary.trim()) return [];

      // Start with the primary conversion
      const candidates = new Set<string>([primary]);

      // Add anusvara variants
      const anuVars = expandAnusvara(primary);
      for (const v of anuVars) candidates.add(v);

      // Add common alternative mappings:
      // 'sh' could be श or ष, 'n' could be न or ण, etc.
      // Generate a variant with Sh→ष swaps
      const withShVariant = lastRomanWord
        .replace(/sh/gi, 'Sh')
        .replace(/Sh/gi, (m) => (m === 'Sh' ? 'sh' : 'Sh'));
      if (withShVariant !== lastRomanWord) {
        const alt = romanToDevanagari(withShVariant);
        if (alt !== primary) candidates.add(alt);
      }

      // Variant: 'n' → 'N' (ण vs न)
      if (/n/i.test(lastRomanWord) && !/N/.test(lastRomanWord)) {
        const nVariant = lastRomanWord.replace(/n/g, 'N');
        const alt = romanToDevanagari(nVariant);
        if (alt !== primary) candidates.add(alt);
      }

      // Variant: 't' → 'T' (ट vs त)
      if (/t/i.test(lastRomanWord) && !/T/.test(lastRomanWord) && !/th/i.test(lastRomanWord)) {
        const tVariant = lastRomanWord.replace(/t/g, 'T');
        const alt = romanToDevanagari(tVariant);
        if (alt !== primary) candidates.add(alt);
      }

      // Variant: 'd' → 'D' (ड vs द)
      if (/d/i.test(lastRomanWord) && !/D/.test(lastRomanWord) && !/dh/i.test(lastRomanWord)) {
        const dVariant = lastRomanWord.replace(/d/g, 'D');
        const alt = romanToDevanagari(dVariant);
        if (alt !== primary) candidates.add(alt);
      }

      return Array.from(candidates).slice(0, 5);
    }, [lastRomanWord]);

    useEffect(() => {
      setShowSuggestions(suggestions.length > 0);
      setSelectedSuggestion(0);
    }, [suggestions]);

    const commitWord = useCallback(
      (suggestionIndex: number = 0) => {
        if (!lastRomanWord || suggestions.length === 0) return value;
        const idx = Math.min(suggestionIndex, suggestions.length - 1);
        const chosen = suggestions[idx];
        const prefix = value.slice(0, value.length - lastRomanWord.length);
        const newValue = prefix + chosen;
        setShowSuggestions(false);
        return newValue;
      },
      [value, lastRomanWord, suggestions],
    );

    const handleKeyDown = useCallback(
      (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (!showSuggestions || suggestions.length === 0) {
          if (e.key === 'Enter') {
            e.preventDefault();
            // Convert any remaining Roman word before submitting
            if (lastRomanWord && suggestions.length > 0) {
              const converted = commitWord(0);
              onChange(converted);
              setTimeout(onSubmit, 0);
            } else {
              onSubmit();
            }
          }
          return;
        }

        // Number keys 1-5 select a suggestion
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= 5 && num <= suggestions.length) {
          e.preventDefault();
          const converted = commitWord(num - 1);
          onChange(converted + ' ');
          return;
        }

        switch (e.key) {
          case ' ':
            e.preventDefault();
            onChange(commitWord(selectedSuggestion) + ' ');
            break;
          case 'Enter':
            e.preventDefault();
            {
              const converted = commitWord(selectedSuggestion);
              onChange(converted);
              setTimeout(onSubmit, 0);
            }
            break;
          case 'Escape':
            e.preventDefault();
            setShowSuggestions(false);
            break;
          case 'ArrowDown':
            e.preventDefault();
            setSelectedSuggestion((prev) => Math.min(prev + 1, suggestions.length - 1));
            break;
          case 'ArrowUp':
            e.preventDefault();
            setSelectedSuggestion((prev) => Math.max(prev - 1, 0));
            break;
          case 'Tab':
            if (suggestions.length > 0) {
              e.preventDefault();
              setSelectedSuggestion((prev) => (prev + 1) % suggestions.length);
            }
            break;
          default:
            break;
        }
      },
      [
        showSuggestions,
        suggestions,
        selectedSuggestion,
        commitWord,
        onChange,
        onSubmit,
        lastRomanWord,
      ],
    );

    return (
      <div className="relative">
        <input
          ref={inputRef}
          type="text"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={handleKeyDown}
          onBlur={() => {
            // Delay hiding so click on suggestion works
            setTimeout(() => setShowSuggestions(false), 200);
          }}
          placeholder={placeholder}
          className={className}
          disabled={disabled}
          autoFocus={autoFocus}
          aria-label={ariaLabel}
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
        />

        {/* Suggestion dropdown */}
        {showSuggestions && suggestions.length > 0 && (
          <div className="absolute left-0 right-0 top-full mt-1 z-50 bg-[rgb(var(--bg))] border border-gold/30 rounded-md shadow-lg overflow-hidden">
            <div className="px-3 py-1.5 text-[10px] tracking-[0.2em] uppercase text-stone-400 dark:text-ivory/50 border-b border-gold/10">
              {lastRomanWord} → (Space to accept, 1-{suggestions.length} to pick)
            </div>
            {suggestions.map((s, i) => (
              <button
                key={s}
                type="button"
                onMouseDown={(e) => {
                  e.preventDefault();
                  onChange(commitWord(i) + ' ');
                }}
                className={`w-full text-left px-3 py-2 flex items-center gap-3 transition-colors ${
                  i === selectedSuggestion
                    ? 'bg-gold/15 text-gold'
                    : 'hover:bg-stone-100 dark:hover:bg-ivory/5'
                }`}
              >
                <span className="text-[11px] font-mono text-gold/60 w-4">{i + 1}</span>
                <span className="text-lg font-medium">{s}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    );
  },
);

HindiInput.displayName = 'HindiInput';

export default HindiInput;
