import type { Metadata } from 'next';
import { EditorialView } from '@/components/workspace/editorial-view';

type Props = { params: Promise<{ slug: string }> };

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  const { slug } = await params;
  return { title: `Editorial · ${slug}` };
}

export default async function EditorialPage({ params }: Props) {
  const { slug } = await params;
  return <EditorialView slug={slug} />;
}
