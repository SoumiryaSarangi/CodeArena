'use client';
import { useSearchParams } from 'next/navigation';
import { Button } from '@/components/ui/button';
import { safeReturnTo } from '@/lib/return-to';

const PROVIDERS = [
  { id: 'google', label: 'Continue with Google' },
  { id: 'github', label: 'Continue with GitHub' },
] as const;

/** S02: two buttons and one line about what we store. No CAPTCHA, nothing to solve (WCAG 3.3.8). */
export function SignIn() {
  const params = useSearchParams();
  const returnTo = safeReturnTo(params.get('returnTo'));
  const failed = params.get('error') === 'oauth-failed';
  return (
    <div className="mx-auto flex max-w-sm flex-col gap-4 py-12">
      <h1 className="text-24 font-semibold tracking-[-0.01em]">Sign in</h1>
      {failed ? (
        <p role="alert" className="text-14 text-danger">
          Sign-in was cancelled. Try again?
        </p>
      ) : null}
      <div className="flex flex-col gap-2">
        {PROVIDERS.map((p) => (
          // A full navigation, not client routing: the API answers with a redirect to the provider.
          <Button key={p.id} asChild variant="secondary" size="lg">
            <a href={`/api/auth/${p.id}?returnTo=${encodeURIComponent(returnTo)}`}>{p.label}</a>
          </Button>
        ))}
      </div>
      <p className="text-13 text-text-3">
        We store your name, email and avatar from the provider, and the code you submit. Nothing
        else.
      </p>
    </div>
  );
}
