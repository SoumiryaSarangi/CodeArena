import type { Metadata } from 'next';
import { Scoreboard } from '@/components/contests/scoreboard';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Scoreboard · ${slug}` };
}

export default async function BoardPage({ params }: Props) {
  const { slug } = await params;
  return <Scoreboard slug={slug} />;
}
