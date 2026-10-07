'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useSession } from '@/lib/session';
import { cn } from '@/lib/cn';

/** Problems for setters and admins; Contests for admins only. */
export function AdminNav() {
  const path = usePathname();
  const { session } = useSession();
  const items = [
    { href: '/admin/problems', label: 'Problems' },
    ...(session.status === 'authed' && session.me.role === 'admin'
      ? [{ href: '/admin/contests', label: 'Contests' }]
      : []),
  ];
  if (items.length < 2) return null;
  return (
    <nav aria-label="Admin sections" className="flex gap-1 border-b border-border-strong pb-2">
      {items.map((i) => {
        const active = path === i.href || path.startsWith(`${i.href}/`);
        return (
          <Link
            key={i.href}
            href={i.href}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'rounded-md px-3 py-1 text-14 text-text-2 hover:bg-surface-2 hover:text-text',
              active && 'bg-surface-2 text-text',
            )}
          >
            {i.label}
          </Link>
        );
      })}
    </nav>
  );
}
