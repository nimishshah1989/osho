'use client';

import { forwardRef } from 'react';

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

const HindiInput = forwardRef<HTMLInputElement, HindiInputProps>(function HindiInput(
  { value, onChange, onSubmit, placeholder, className, disabled, autoFocus, ariaLabel },
  ref,
) {
  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      onSubmit();
    }
  };

  return (
    <input
      ref={ref}
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      className={className}
      disabled={disabled}
      autoFocus={autoFocus}
      aria-label={ariaLabel}
      autoComplete="off"
      autoCorrect="off"
      autoCapitalize="off"
      spellCheck={false}
    />
  );
});

export default HindiInput;
