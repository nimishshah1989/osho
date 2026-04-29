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
import { romanToDevanagari, expandAnusvara, expandVowelVariants } from '../lib/transliterate';

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

    // Generate suggestions for the current Roman word.
    // Priority order:
    //   1. Vowel-expanded forms of the primary conversion (e.g. ज्ञान before ज्ञन)
    //   2. Consonant-alternative variants (sh/Sh, n/N, t/T, d/D)
    //   3. Anusvara variants of all of the above
    const suggestions = useMemo(() => {
      if (!lastRomanWord) return [];
      const primary = romanToDevanagari(lastRomanWord);
      if (!primary.trim()) return [];

      // Consonant-alternative roman strings to try
      const romanVariants: string[] = [lastRomanWord];

      if (/sh/i.test(lastRomanWord)) {
        romanVariants.push(lastRomanWord.replace(/sh/gi, 'Sh'));
        romanVariants.push(lastRomanWord.replace(/Sh/gi, 'sh'));
      }
      if (/n/.test(lastRomanWord) && !/N/.test(lastRomanWord))
        romanVariants.push(lastRomanWord.replace(/n/g, 'N'));
      if (/t/.test(lastRomanWord) && !/T/.test(lastRomanWord) && !/th/i.test(lastRomanWord))
        romanVariants.push(lastRomanWord.replace(/t/g, 'T'));
      if (/d/.test(lastRomanWord) && !/D/.test(lastRomanWord) && !/dh/i.test(lastRomanWord))
        romanVariants.push(lastRomanWord.replace(/d/g, 'D'));
      if (/r/.test(lastRomanWord))
        romanVariants.push(lastRomanWord.replace(/r/g, 'R')); // ड़/ढ़ variants
      // th → Th (थ dental → ठ retroflex) and dh → Dh (ध → ढ)
      // lets "thik" suggest ठीक alongside थिक
      if (/th/i.test(lastRomanWord) && !/Th/.test(lastRomanWord))
        romanVariants.push(lastRomanWord.replace(/th/gi, 'Th'));
      if (/dh/i.test(lastRomanWord) && !/Dh/.test(lastRomanWord))
        romanVariants.push(lastRomanWord.replace(/dh/gi, 'Dh'));

      // For each roman variant: get Devanagari, expand vowels, expand anusvara
      // Deduplicated, vowel-expanded forms come first (they're more likely correct)
      const seen = new Set<string>();
      const ordered: string[] = [];

      const add = (word: string) => {
        if (!seen.has(word)) { seen.add(word); ordered.push(word); }
      };

      for (const roman of romanVariants) {
        const deva = romanToDevanagari(roman);
        if (!deva.trim()) continue;
        // Vowel-expanded forms first (ज्ञान before ज्ञन)
        for (const v of expandVowelVariants(deva)) {
          for (const a of expandAnusvara(v)) add(a);
        }
      }

      return ordered.slice(0, 8);
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
