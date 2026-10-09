import type { Metadata } from 'next';
import { Suspense } from 'react';
import { JoinRoom } from '@/components/pad/join-room';

export const metadata: Metadata = { title: 'Join a room' };

export default function JoinPage() {
  return (
    <Suspense>
      <JoinRoom />
    </Suspense>
  );
}
