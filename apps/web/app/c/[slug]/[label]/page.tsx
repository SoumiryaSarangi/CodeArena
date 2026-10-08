import type { Metadata } from 'next';
import { ContestArena } from '@/components/contests/arena';

type Props = { params: Promise<{ slug: string; label: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug, label } = await params;
  return { title: `${label.toUpperCase()} · ${slug}` };
}

export default async function ArenaPage({ params }: Props) {
  const { slug, label } = await params;
  return <ContestArena slug={slug} label={label.toUpperCase()} />;
}
