import type { Metadata } from 'next';
import { Workspace } from '@/components/workspace/workspace';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: slug };
}

export default async function ProblemPage({ params }: Props) {
  const { slug } = await params;
  return <Workspace slug={slug} />;
}
