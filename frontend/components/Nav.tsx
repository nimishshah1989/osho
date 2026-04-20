'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { Library, MessageCircle, Sparkles } from 'lucide-react';

const ITEMS = [
  { href: '/', label: 'Archive', Icon: Library },
  { href: '/constellation', label: 'Constellation', Icon: Sparkles },
  { href: '/ask', label: 'Ask', Icon: MessageCircle },
];

export default function Nav() {
  const pathname = usePathname();
  return (
    <nav className="fixed top-0 inset-x-0 z-50 px-6 md:px-8 py-5 flex justify-between items-center backdrop-blur-md bg-black/40 border-b border-gold/5">
      <Link href="/" className="flex items-center gap-3 no-underline group" aria-label="Osho Speaks home">
        <div className="w-8 h-[1px] bg-gold group-hover:w-12 transition-all" />
        <span className="text-[11px] tracking-[0.5em] uppercase text-white font-medium">
          OSHO <span className="text-gold italic">SPEAKS..</span>
        </span>
      </Link>
      <div className="flex gap-6 md:gap-10">
        {ITEMS.map(({ href, label, Icon }) => {
          const active = pathname === href || (href !== '/' && pathname?.startsWith(href));
          return (
            <Link
              key={href}
              href={href}
              aria-current={active ? 'page' : undefined}
              className={`text-[9px] tracking-[0.4em] uppercase flex items-center gap-2 transition-opacity ${
                active ? 'text-gold opacity-100' : 'text-ivory/75 hover:text-ivory opacity-100'
              }`}
            >
              <Icon size={12} /> {label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
