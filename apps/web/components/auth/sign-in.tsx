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
    <div className="mx-auto grid w-full max-w-3xl gap-10 py-10 md:grid-cols-[22rem_1fr] md:py-14">
      <div className="flex flex-col gap-4">
        <h1 className="text-28 font-semibold tracking-[-0.01em]">Sign in</h1>
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
          else.{' '}
          <a href="/privacy" className="text-accent underline">
            Privacy
          </a>
          {' · '}
          <a href="/terms" className="text-accent underline">
            Terms
          </a>
        </p>
      </div>
      <aside aria-labelledby="after-signin" className="flex flex-col gap-4 md:pt-12">
        <h2 id="after-signin" className="text-18 font-semibold">
          After you sign in
        </h2>
        <ul className="flex flex-col gap-3 text-14 text-text-2">
          <li>
            <span className="font-medium text-text">Choose a handle</span>, the name others see on
            the scoreboard.
          </li>
          <li>
            <span className="font-medium text-text">Practise</span> on public problems that a real
            judge checks, with live progress while it runs.
          </li>
          <li>
            <span className="font-medium text-text">Join a contest</span> or{' '}
            <span className="font-medium text-text">run a mock interview</span> in a shared editor.
          </li>
        </ul>
      </aside>
    </div>
  );
}
