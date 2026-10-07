import type { Metadata } from 'next';
import { ProblemList } from '@/components/admin/problem-list';
import { SetterGate } from '@/components/admin/setter-gate';

export const metadata: Metadata = { title: 'Problems · Admin' };

export default function AdminProblemsPage() {
  return (
    <SetterGate>
      <ProblemList />
    </SetterGate>
  );
}
