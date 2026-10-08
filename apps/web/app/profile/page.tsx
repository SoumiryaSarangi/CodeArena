import type { Metadata } from 'next';
import { MyProfileRedirect } from '@/components/profile/my-profile-redirect';

export const metadata: Metadata = { title: 'Profile' };

export default function Page() {
  return <MyProfileRedirect />;
}
