import type { Metadata } from 'next';
import { AdminNav } from '@/components/admin/admin-nav';
import { ContestAdminList } from '@/components/admin/contest-list';
import { SetterGate } from '@/components/admin/setter-gate';

export const metadata: Metadata = { title: 'Contests · Admin' };

export default function AdminContestsPage() {
  return (
    <SetterGate min="admin" what="contests">
      <div className="flex flex-col gap-6">
        <AdminNav />
        <ContestAdminList />
      </div>
    </SetterGate>
  );
}
