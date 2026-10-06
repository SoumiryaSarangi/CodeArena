import type { Metadata } from 'next';
import { SubmissionDetailView } from '@/components/submission/submission-detail';

type Props = { params: Promise<{ id: string }> };

export const metadata: Metadata = { title: 'Submission' };

export default async function SubmissionPage({ params }: Props) {
  const { id } = await params;
  return <SubmissionDetailView id={id} />;
}
