import type { Metadata } from 'next';
import { Suspense } from 'react';
import { PracticeList } from '@/components/practice/practice-list';
import { Skeleton } from '@/components/ui/states';

export const metadata: Metadata = { title: 'Practice' };

export default function PracticePage() {
  // useSearchParams needs a Suspense boundary so the rest of the page can render statically.
  return (
    <Suspense fallback={<Skeleton className="h-64 w-full" />}>
      <PracticeList />
    </Suspense>
  );
}
