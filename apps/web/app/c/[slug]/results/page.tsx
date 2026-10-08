import type { Metadata } from 'next';
import { ContestResultsView } from '@/components/contests/results';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Results · ${slug}` };
}

export default async function ResultsPage({ params }: Props) {
  const { slug } = await params;
  return <ContestResultsView slug={slug} />;
}
