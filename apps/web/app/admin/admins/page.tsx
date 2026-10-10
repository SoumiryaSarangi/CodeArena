import type { Metadata } from 'next';
import { AdminGrants } from '@/components/admin/admin-grants';
import { AdminNav } from '@/components/admin/admin-nav';
import { SetterGate } from '@/components/admin/setter-gate';

export const metadata: Metadata = { title: 'Admins · Admin' };

export default function AdminAdminsPage() {
  return (
    <SetterGate min="admin" what="admins">
      <div className="flex flex-col gap-6">
        <AdminNav />
        <AdminGrants />
      </div>
    </SetterGate>
  );
}
