import type { Metadata } from 'next';
import { AdminNav } from '@/components/admin/admin-nav';
import { IntegrityReview } from '@/components/admin/integrity/integrity-review';
import { SetterGate } from '@/components/admin/setter-gate';

export const metadata: Metadata = { title: 'Similar submissions · Admin' };

type Props = { params: Promise<{ runId: string }> };

export default async function AdminIntegrityRunPage({ params }: Props) {
  const { runId } = await params;
  return (
    <SetterGate min="admin" what="integrity checks">
      <div className="flex flex-col gap-6">
        <AdminNav />
        <IntegrityReview runId={runId} />
      </div>
    </SetterGate>
  );
}
