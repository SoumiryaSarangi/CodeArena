import type { Metadata } from 'next';
import { AdminNav } from '@/components/admin/admin-nav';
import { IntegrityRuns } from '@/components/admin/integrity/integrity-runs';
import { SetterGate } from '@/components/admin/setter-gate';

export const metadata: Metadata = { title: 'Integrity · Admin' };

export default function AdminIntegrityPage() {
  return (
    <SetterGate min="admin" what="integrity checks">
      <div className="flex flex-col gap-6">
        <AdminNav />
        <IntegrityRuns />
      </div>
    </SetterGate>
  );
}
