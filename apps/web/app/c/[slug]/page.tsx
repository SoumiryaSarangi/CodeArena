import type { Metadata } from 'next';
import { ContestLobby } from '@/components/contests/lobby';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Contest · ${slug}` };
}

export default async function ContestPage({ params }: Props) {
  const { slug } = await params;
  return <ContestLobby slug={slug} />;
}
