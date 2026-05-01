'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Library, Search, Sparkles, Sun, Moon, HelpCircle } from 'lucide-react';
import { useLocale } from '../lib/i18n';
import { useTheme } from '../lib/theme';

export default function Nav() {
  const pathname = usePathname();
  const { locale, setLocale, t } = useLocale();
  const { theme, toggleTheme } = useTheme();

  const isActive = (href: string) =>
    pathname === href || (href !== '/' && pathname?.startsWith(href));

  const linkClass = (href: string) =>
    `text-[11px] md:text-[13px] tracking-[0.2em] md:tracking-[0.25em] uppercase flex items-center gap-2 transition-colors ${
      isActive(href)
        ? 'text-gold'
        : 'text-stone-500 dark:text-ivory/65 hover:text-stone-900 dark:hover:text-ivory'
    }`;

  return (
    <nav className="fixed top-0 inset-x-0 z-50 px-4 md:px-8 py-4 flex justify-between items-center backdrop-blur-md bg-[rgb(var(--bg))]/80 border-b border-gold/20 dark:border-gold/8">

      {/* Left cluster: Search · Lang · Theme */}
      <div className="flex items-center gap-3 md:gap-6">
        <Link href="/" aria-current={isActive('/') ? 'page' : undefined} className={linkClass('/')}>
          <Search size={12} />
          <span className="hidden sm:inline">{t('nav.search')}</span>
        </Link>

        {/* Language toggle */}
        <div
          role="group"
          aria-label="Language"
          className="flex items-center gap-1 text-[11px] md:text-[13px] tracking-[0.1em] pl-3 border-l border-gold/20 dark:border-gold/15"
        >
          <button
            type="button"
            onClick={() => setLocale('en')}
            aria-pressed={locale === 'en'}
            className={
              locale === 'en'
                ? 'text-gold'
                : 'text-stone-500 dark:text-ivory/55 hover:text-stone-900 dark:hover:text-ivory'
            }
          >
            EN
          </button>
          <span className="opacity-30">|</span>
          <button
            type="button"
            onClick={() => setLocale('hi')}
            aria-pressed={locale === 'hi'}
            className={
              locale === 'hi'
                ? 'text-gold'
                : 'text-stone-500 dark:text-ivory/55 hover:text-stone-900 dark:hover:text-ivory'
            }
          >
            हिं
          </button>
        </div>

        {/* Day / Night toggle */}
        <button
          type="button"
          onClick={toggleTheme}
          aria-label={theme === 'dark' ? t('nav.theme.light') : t('nav.theme.dark')}
          className="text-stone-500 dark:text-ivory/55 hover:text-gold dark:hover:text-gold transition-colors"
        >
          {theme === 'dark' ? <Sun size={13} /> : <Moon size={13} />}
        </button>
      </div>

      {/* Right cluster: Archive · Constellation */}
      <div className="flex items-center gap-4 md:gap-8">
        <Link href="/archive" aria-current={isActive('/archive') ? 'page' : undefined} className={linkClass('/archive')}>
          <Library size={12} />
          <span className="hidden sm:inline">{t('nav.archive')}</span>
        </Link>
        <Link href="/constellation" aria-current={isActive('/constellation') ? 'page' : undefined} className={linkClass('/constellation')}>
          <Sparkles size={12} />
          <span className="hidden sm:inline">{t('nav.constellation')}</span>
        </Link>
        <Link href="/help" aria-current={isActive('/help') ? 'page' : undefined} className={linkClass('/help')}>
          <HelpCircle size={12} />
          <span className="hidden sm:inline">Help</span>
        </Link>
      </div>
    </nav>
  );
}
