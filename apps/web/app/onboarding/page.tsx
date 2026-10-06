import type { Metadata } from 'next';
import { Suspense } from 'react';
import { Onboarding } from '@/components/auth/onboarding';

export const metadata: Metadata = { title: 'Choose your handle' };

export default function OnboardingPage() {
  return (
    <Suspense>
      <Onboarding />
    </Suspense>
  );
}
