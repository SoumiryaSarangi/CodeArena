'use client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useEffect } from 'react';
import { EmptyState, Skeleton } from '@/components/ui/states';
import { signInHref, useSession } from '@/lib/session';

/** `/profile` is "my profile": it goes to `/u/<my handle>`, or asks to sign in first. */
export function MyProfileRedirect() {
  const { session } = useSession();
  const router = useRouter();
  const handle = session.status === 'authed' ? session.me.handle : null;
  useEffect(() => {
    if (handle) router.replace(`/u/${handle}`);
  }, [handle, router]);
  if (session.status === 'loading' || handle) return <Skeleton className="h-40 w-full" />;
  if (session.status === 'authed') {
    return (
      <EmptyState
        message="Pick a handle to get a profile."
        action={
          <Link href="/onboarding" className="underline">
            Choose a handle
          </Link>
        }
      />
    );
  }
  return (
    <EmptyState
      message="Sign in to see your profile."
      action={
        <Link href={signInHref('/profile')} className="underline">
          Sign in
        </Link>
      }
    />
  );
}
