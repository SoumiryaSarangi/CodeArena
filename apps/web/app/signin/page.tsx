import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SignIn } from '@/components/auth/sign-in';

export const metadata: Metadata = { title: 'Sign in' };

export default function SignInPage() {
  return (
    <Suspense>
      <SignIn />
    </Suspense>
  );
}
