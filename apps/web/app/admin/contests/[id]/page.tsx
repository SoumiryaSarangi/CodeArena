import type { Metadata } from 'next';
import { AdminNav } from '@/components/admin/admin-nav';
import { ContestEditor } from '@/components/admin/contest-editor';
import { SetterGate } from '@/components/admin/setter-gate';

export const metadata: Metadata = { title: 'Contest · Admin' };

type Props = { params: Promise<{ id: string }> };

export default async function AdminContestPage({ params }: Props) {
  const { id } = await params;
  return (
    <SetterGate min="admin" what="contests">
      <div className="flex flex-col gap-6">
        <AdminNav />
        <ContestEditor id={id} />
      </div>
    </SetterGate>
  );
}
