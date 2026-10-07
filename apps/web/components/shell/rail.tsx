'use client';
import { Code, Home, Trophy, User, Users, Wrench } from 'lucide-react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { cn } from '@/lib/cn';
import { useSession } from '@/lib/session';
import { NAV } from '@/lib/shortcuts';

const ICONS = {
  home: Home,
  code: Code,
  trophy: Trophy,
  users: Users,
  user: User,
  tool: Wrench,
} as const;

/** Setters and admins get one more entry (UI-04); the API checks the role on every call anyway. */
const ADMIN = { href: '/admin/problems', label: 'Admin', icon: 'tool' } as const;

/**
 * Left rail: icons at md, labels at xl; under md it becomes a bottom bar. Admin is a role-gated
 * entry for setters and admins.
 */
export function Rail() {
  const path = usePathname();
  const { session } = useSession();
  const items = session.status === 'authed' && session.me.role !== 'user' ? [...NAV, ADMIN] : NAV;
  return (
    <nav
      aria-label="Main"
      className={cn(
        'fixed inset-x-0 bottom-0 z-30 flex h-12 justify-around border-t border-border-strong bg-surface-1',
        'md:inset-y-0 md:left-0 md:right-auto md:top-12 md:h-auto md:w-14 md:flex-col md:justify-start md:gap-1 md:border-r md:border-t-0 md:p-2',
        'xl:w-48',
      )}
    >
      {items.map(({ href, label, icon }) => {
        const Icon = ICONS[icon];
        const active = path === href || path.startsWith(`${href}/`);
        return (
          <Link
            key={href}
            href={href}
            aria-current={active ? 'page' : undefined}
            aria-label={label}
            className={cn(
              'flex min-w-12 flex-col items-center justify-center gap-0.5 rounded-md text-12 text-text-2 hover:bg-surface-2 hover:text-text',
              'md:h-8 md:flex-row md:justify-center md:gap-3 md:text-14 xl:justify-start xl:px-2',
              active && 'bg-surface-2 text-text',
            )}
          >
            <Icon className="size-4 shrink-0" aria-hidden />
            <span className="md:sr-only xl:not-sr-only">{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
