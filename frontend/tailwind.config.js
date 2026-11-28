/** @type {import('tailwindcss').Config} */
module.exports = {
  darkMode: 'class',
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
    './lib/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      colors: {
        // CSS-variable-driven: dark mode uses warm gold, light mode uses darker amber
        // so opacity modifiers (text-gold/60 etc.) still work correctly
        gold: 'rgb(var(--gold) / <alpha-value>)',
        // Hyperlinks only (Sugit 2026-11-28): red in light mode, gold in dark.
        // Colour alone says "link"; a hover underline confirms it.
        link: 'rgb(var(--link) / <alpha-value>)',
        ivory: '#faf9f6',
      },
      fontFamily: {
        sans: ['var(--font-inter)', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
        serif: ['var(--font-inter)', '-apple-system', 'BlinkMacSystemFont', 'sans-serif'],
      },
      animation: {
        'in': 'fadeIn 0.7s ease-out',
      },
      keyframes: {
        fadeIn: {
          '0%': { opacity: '0', transform: 'translateY(8px)' },
          '100%': { opacity: '1', transform: 'translateY(0)' },
        },
      },
    },
  },
  plugins: [],
};
