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
  const isStaff = session.status === 'authed' && session.me.role !== 'user';
  // Where you go (top) and where you are / what you run (bottom, the usual place for account and
  // settings). Admin sits above Profile, in the bottom group, because it is a tool and not a destination.
  const top = NAV.filter((i) => i.icon !== 'user');
  const bottom = [...(isStaff ? [ADMIN] : []), ...NAV.filter((i) => i.icon === 'user')];

  const link = ({
    href,
    label,
    icon,
  }: {
    href: string;
    label: string;
    icon: keyof typeof ICONS;
  }) => {
    const Icon = ICONS[icon];
    const active = path === href || path.startsWith(`${href}/`);
    return (
      <Link
        key={href}
        href={href}
        aria-current={active ? 'page' : undefined}
        aria-label={label}
        className={cn(
          'relative flex min-w-12 flex-col items-center justify-center gap-0.5 rounded-md text-12 text-text-2 transition-colors duration-[var(--dur-fast)] hover:bg-surface-2 hover:text-text',
          'md:h-9 md:flex-row md:justify-center md:gap-3 md:text-14 xl:justify-start xl:px-2',
          active &&
            'bg-surface-2 font-medium text-text before:absolute before:inset-x-3 before:top-0 before:h-0.5 before:rounded-full before:bg-primary md:before:inset-x-auto md:before:inset-y-2 md:before:-left-2 md:before:h-auto md:before:w-0.5 xl:before:-left-2',
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        <span className="md:sr-only xl:not-sr-only">{label}</span>
      </Link>
    );
  };

  return (
    <nav
      aria-label="Main"
      className={cn(
        'glass fixed inset-x-0 bottom-0 z-30 flex h-[calc(3.5rem+env(safe-area-inset-bottom))] justify-around border-t border-border-strong pb-[env(safe-area-inset-bottom)] md:pb-0',
        'md:inset-y-0 md:left-0 md:right-auto md:top-12 md:h-auto md:w-14 md:flex-col md:justify-start md:gap-1 md:border-r md:border-t-0 md:p-2',
        'xl:w-48',
      )}
    >
      {top.map(link)}
      {/* On phones one row; from 768 px the account group is pushed to the bottom of the column. */}
      <div className="contents md:mt-auto md:flex md:flex-col md:gap-1 md:border-t md:border-border md:pt-2">
        {bottom.map(link)}
      </div>
    </nav>
  );
}
