import type { Metadata } from 'next';
import { ContestListView } from '@/components/contests/contest-list';

export const metadata: Metadata = { title: 'Contests' };

export default function ContestsPage() {
  return <ContestListView />;
}
