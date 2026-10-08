import type { Metadata } from 'next';
import { AdminNav } from '@/components/admin/admin-nav';
import { ContestOps } from '@/components/admin/contest-ops';
import { SetterGate } from '@/components/admin/setter-gate';

export const metadata: Metadata = { title: 'Operations · Admin' };

type Props = { params: Promise<{ id: string }> };

export default async function ContestOpsPage({ params }: Props) {
  const { id } = await params;
  return (
    <SetterGate min="admin" what="contests">
      <div className="flex flex-col gap-6">
        <AdminNav />
        <ContestOps id={id} />
      </div>
    </SetterGate>
  );
}
