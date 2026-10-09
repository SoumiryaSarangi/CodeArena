import type { Metadata } from 'next';
import { InterviewList } from '@/components/pad/interview-list';

export const metadata: Metadata = { title: 'Interview rooms' };

export default function InterviewPage() {
  return <InterviewList />;
}
