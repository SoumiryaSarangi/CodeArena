'use client';
import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { EmptyState, Skeleton } from '@/components/ui/states';
import { joinRoom } from '@/lib/rooms';
import { signInHref, useSession } from '@/lib/session';

/** `/r/join?token=`: an invite link. Signed in: join and go to the room; otherwise sign in first and come back here. */
export function JoinRoom() {
  const sp = useSearchParams();
  const router = useRouter();
  const { session } = useSession();
  const token = sp.get('token') ?? '';
  const [failure, setFailure] = useState<string | null>(null);
  const authed = session.status === 'authed';

  useEffect(() => {
    if (!authed || !token) return;
    let live = true;
    joinRoom(token).then(
      (r) => live && router.replace(`/r/${r.roomId}`),
      (e: Error) => live && setFailure(e.message),
    );
    return () => {
      live = false;
    };
  }, [authed, token, router]);

  if (!token) return <EmptyState message="This invite link is incomplete." />;
  if (session.status === 'loading') return <Skeleton className="h-32 w-full" />;
  if (session.status === 'guest') {
    return (
      <EmptyState
        message="Sign in to join the interview room."
        action={
          <Button asChild variant="primary">
            <Link href={signInHref(`/r/join?token=${encodeURIComponent(token)}`)}>Sign in</Link>
          </Button>
        }
      />
    );
  }
  if (failure) {
    return (
      <EmptyState
        message={failure}
        action={
          <Button asChild variant="secondary">
            <Link href="/interview">Your rooms</Link>
          </Button>
        }
      />
    );
  }
  return (
    <p role="status" className="text-14 text-text-2">
      Joining the room…
    </p>
  );
}
