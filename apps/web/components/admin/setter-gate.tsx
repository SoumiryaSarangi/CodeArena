'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState, Skeleton } from '@/components/ui/states';
import { signInHref, useSession } from '@/lib/session';

/**
 * The setter screens are for setters and admins. The API enforces this on every call; the gate
 * only spares everyone else a screen that could never load.
 */
export function SetterGate({ children }: { children: ReactNode }) {
  const { session } = useSession();
  const path = usePathname();
  if (session.status === 'loading') return <Skeleton className="h-64 w-full" />;
  if (session.status === 'guest') {
    return (
      <EmptyState
        message="Sign in to manage problems."
        action={
          <Button asChild variant="primary">
            <Link href={signInHref(path)}>Sign in</Link>
          </Button>
        }
      />
    );
  }
  if (session.me.role === 'user') {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="text-24 font-semibold tracking-[-0.01em]">Not allowed</h1>
        <p className="text-14 text-text-2">Only setters and admins can manage problems.</p>
      </div>
    );
  }
  return <>{children}</>;
}
