'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Library, MessageCircle, Sparkles } from 'lucide-react';
import { useLocale } from '../lib/i18n';

export default function Nav() {
  const pathname = usePathname();
  const { locale, setLocale, t } = useLocale();

  const items = [
    { href: '/', label: t('nav.archive'), Icon: Library },
    { href: '/constellation', label: t('nav.constellation'), Icon: Sparkles },
    { href: '/ask', label: t('nav.ask'), Icon: MessageCircle },
  ];

  return (
    <nav className="fixed top-0 inset-x-0 z-50 px-6 md:px-8 py-5 flex justify-between items-center backdrop-blur-md bg-black/40 border-b border-gold/5">
      <Link href="/" className="flex items-center gap-3 no-underline group" aria-label="Osho Speaks home">
        <div className="w-8 h-[1px] bg-gold group-hover:w-12 transition-all" />
        <span className="text-[11px] tracking-[0.5em] uppercase text-white font-medium">
          OSHO{' '}
          <span
            className={`text-gold italic ${
              locale === 'hi' ? 'normal-case tracking-normal text-[12px]' : ''
            }`}
          >
            {t('brand.tagline')}
          </span>
        </span>
      </Link>

      <div className="flex gap-5 md:gap-8 items-center">
        {items.map(({ href, label, Icon }) => {
          const active = pathname === href || (href !== '/' && pathname?.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`text-[9px] md:text-[10px] tracking-[0.3em] md:tracking-[0.4em] uppercase flex items-center gap-2 transition-opacity ${
                active ? 'text-gold opacity-100' : 'text-ivory/75 hover:text-ivory opacity-100'
              }`}
            >
              <Icon size={12} /> {label}
            </Link>
          );
        })}

        <div
          role="group"
          aria-label="Language"
          className="flex items-center gap-1 text-[9px] md:text-[10px] tracking-[0.2em] ml-1 pl-3 border-l border-gold/15"
        >
          <button
            type="button"
            onClick={() => setLocale('en')}
            aria-pressed={locale === 'en'}
            className={locale === 'en' ? 'text-gold' : 'text-ivory/60 hover:text-ivory'}
          >
            EN
          </button>
          <span className="opacity-30">|</span>
          <button
            type="button"
            onClick={() => setLocale('hi')}
            aria-pressed={locale === 'hi'}
            className={locale === 'hi' ? 'text-gold' : 'text-ivory/60 hover:text-ivory'}
          >
            हिं
          </button>
        </div>
      </div>
    </nav>
  );
}
