import type { Metadata } from 'next';
import { ResolverView } from '@/components/contests/resolver-view';
import { Scoreboard } from '@/components/contests/scoreboard';

type Props = {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ present?: string }>;
};

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Scoreboard · ${slug}` };
}

export default async function BoardPage({ params, searchParams }: Props) {
  const { slug } = await params;
  const { present } = await searchParams;
  return present === '1' ? <ResolverView slug={slug} /> : <Scoreboard slug={slug} />;
}
