import type { Metadata } from 'next';
import { RoomPage } from '@/components/pad/room-view';

export const metadata: Metadata = { title: 'Interview room' };

type Props = { params: Promise<{ roomId: string }> };

export default async function Room({ params }: Props) {
  const { roomId } = await params;
  return <RoomPage roomId={roomId} />;
}
