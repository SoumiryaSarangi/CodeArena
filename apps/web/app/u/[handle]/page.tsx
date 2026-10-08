import type { Metadata } from 'next';
import { Profile } from '@/components/profile/profile';

type Props = { params: Promise<{ handle: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { handle } = await params;
  return { title: `${handle} · Profile` };
}

export default async function ProfilePage({ params }: Props) {
  const { handle } = await params;
  return <Profile handle={handle} />;
}
