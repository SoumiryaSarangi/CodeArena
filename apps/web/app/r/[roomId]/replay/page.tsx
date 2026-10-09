import type { Metadata } from 'next';
import { ReplayPage } from '@/components/pad/replay-view';

export const metadata: Metadata = { title: 'Replay · Interview room' };

type Props = { params: Promise<{ roomId: string }> };

export default async function Replay({ params }: Props) {
  const { roomId } = await params;
  return <ReplayPage roomId={roomId} />;
}
