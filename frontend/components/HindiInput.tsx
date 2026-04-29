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
import { romanToDevanagari } from '../lib/transliterate';

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

// Module-level cache persists across renders — avoids re-fetching the same word
const suggestionCache = new Map<string, string[]>();

async function fetchGoogleSuggestions(word: string): Promise<string[]> {
  if (suggestionCache.has(word)) return suggestionCache.get(word)!;
  try {
    const url = `https://inputtools.google.com/request?text=${encodeURIComponent(word)}&itc=hi-t-i0-und&num=8&cp=0&cs=1&ie=utf-8&oe=utf-8&app=demopage`;
    const res = await fetch(url);
    const data = await res.json();
    // Response: ["SUCCESS", [["word", ["cand1", "cand2", ...], {...}]]]
    if (data[0] === 'SUCCESS' && data[1]?.[0]?.[1]?.length) {
      const candidates: string[] = data[1][0][1];
      suggestionCache.set(word, candidates);
      return candidates;
    }
  } catch {
    // Network error or CORS — fall through to local fallback
  }
  // Fallback: local rule-based transliteration
  const local = romanToDevanagari(word);
  if (local.trim()) {
    const result = [local];
    suggestionCache.set(word, result);
    return result;
  }
  return [];
}

/**
 * Hindi transliteration input — powered by Google Input Tools API.
 *
 * Behavior:
 * - User types Roman characters; a floating suggestion panel shows Devanagari candidates
 * - On Space: top suggestion replaces the Roman word in-place
 * - On number key (1-8): selects that numbered suggestion
 * - On Escape: dismisses suggestions and keeps Roman text
 * - On Enter: submits the form (converting any pending Roman word first)
 * - Already-converted Devanagari words stay in the input
 */
const HindiInput = forwardRef<HindiInputHandle, HindiInputProps>(
  ({ value, onChange, onSubmit, placeholder, className, disabled, autoFocus, ariaLabel }, ref) => {
    const inputRef = useRef<HTMLInputElement>(null);
    const [suggestions, setSuggestions] = useState<string[]>([]);
    const [showSuggestions, setShowSuggestions] = useState(false);
    const [selectedSuggestion, setSelectedSuggestion] = useState(0);
    const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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

    // Fetch suggestions with 300ms debounce
    useEffect(() => {
      if (!lastRomanWord) {
        setSuggestions([]);
        setShowSuggestions(false);
        return;
      }
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => {
        fetchGoogleSuggestions(lastRomanWord).then((candidates) => {
          setSuggestions(candidates);
          setShowSuggestions(candidates.length > 0);
          setSelectedSuggestion(0);
        });
      }, 300);
      return () => {
        if (debounceRef.current) clearTimeout(debounceRef.current);
      };
    }, [lastRomanWord]);

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

        // Number keys 1-8 select a suggestion
        const num = parseInt(e.key, 10);
        if (num >= 1 && num <= 8 && num <= suggestions.length) {
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
              {lastRomanWord} → (Space to accept, 1–{Math.min(suggestions.length, 8)} to pick)
            </div>
            {suggestions.slice(0, 8).map((s, i) => (
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
