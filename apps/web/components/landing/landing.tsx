'use client';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { signInHref, useSession } from '@/lib/session';

/** The one action: sign in, or carry on if you already are. Never a second filled button. */
function PrimaryAction() {
  const { session } = useSession();
  if (session.status === 'authed') {
    return (
      <Button asChild size="lg">
        <Link href="/home">Open your home</Link>
      </Button>
    );
  }
  return (
    <Button asChild variant="primary" size="lg">
      <Link href={signInHref('/home')}>Sign in to start</Link>
    </Button>
  );
}

/** The path one submission takes, in the words the submission page uses for it. */
const JOURNEY = [
  'Submitted',
  'Queued',
  'Claimed by a judge',
  'Compiled',
  'Run test by test',
  'Verdict',
] as const;

/**
 * Every number here is in `docs/METRICS.md`, with the run and date named in the sentence and the caveat METRICS.md writes beside it. Nothing on this
 * page is a customer count, a quote or an estimate (PRODUCT.md: absent evidence is not invented).
 */
const EVIDENCE = [
  {
    claim: 'A verdict in 2.1 seconds, at the 95th percentile.',
    detail:
      'Load test on production, 8 October 2026: 500 submissions in two minutes, two judge machines, 195 of 200 live listeners connected, on light test problems (a heavier problem takes longer).',
  },
  {
    claim: 'Twenty-eight attack programs, all contained.',
    detail:
      'Fork bombs, memory bombs, symlink and /proc reads, network, ptrace, chroot escapes. They run against a real judge machine every night.',
  },
  {
    claim: 'Six failure drills pass on production.',
    detail:
      'Redis killed outright, among others: every accepted submission still got exactly one verdict.',
  },
  {
    claim: 'An interview pad that keeps up: 2.1 ms at the 95th percentile.',
    detail:
      'Run of 9 October 2026: thirty people typing in ten rooms at once, the target 200 ms, nothing lost or doubled. Measured on one machine, without a network.',
  },
] as const;

const THINGS = [
  {
    name: 'Practise',
    href: '/practice',
    text: 'Public problems with a real judge behind them. Hints that help you think and never write the answer.',
  },
  {
    name: 'Compete',
    href: '/contests',
    text: 'Live contests with a scoreboard that moves as people solve. After the end, a review of your own code.',
  },
  {
    name: 'Interview',
    href: '/interview',
    text: 'A shared editor for mock interviews, on the same judge, with a replay of the whole session.',
  },
] as const;

/** S01: the public front door, for a student on campus and for someone following a link to see how it is built. */
export function Landing() {
  return (
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-20 py-6 md:py-16">
      <section aria-labelledby="hero" className="flex max-w-[44rem] flex-col gap-6">
        <h1
          id="hero"
          className="display text-[2.5rem] font-semibold leading-[1.05] text-balance md:text-72"
        >
          The place your campus codes together
        </h1>
        <p className="max-w-[36rem] text-16 text-text-2 md:text-18">
          Practise problems, compete in live contests, and run mock interviews, on a judge your
          campus owns: its problems, its timing, its data.
        </p>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
          <PrimaryAction />
          <Link
            href="/status"
            className="text-14 text-text-2 underline underline-offset-4 hover:text-text"
          >
            See how it is built
          </Link>
        </div>
      </section>

      <section aria-labelledby="journey" className="flex flex-col gap-5">
        <h2 id="journey" className="max-w-[36rem] text-22 font-semibold">
          You can watch your code being judged
        </h2>
        <ol className="grid gap-px overflow-hidden rounded-lg border border-border bg-border grid-cols-2 sm:grid-cols-3 lg:grid-cols-6">
          {JOURNEY.map((step, i) => (
            <li key={step} className="flex flex-col gap-1 bg-surface-1 px-4 py-4">
              <span className="font-mono text-12 text-text-3">{i + 1}</span>
              <span className="text-14 font-medium">{step}</span>
            </li>
          ))}
        </ol>
        <p className="max-w-[36rem] text-14 text-text-2">
          Every submission shows where it is: its place in the queue, the judge that took it, and
          each test as it finishes.
        </p>
      </section>

      <section aria-labelledby="evidence" className="flex flex-col gap-6">
        <h2 id="evidence" className="max-w-[36rem] text-22 font-semibold">
          Measured, with the run behind each number
        </h2>
        <dl className="grid gap-x-12 gap-y-8 md:grid-cols-2">
          {EVIDENCE.map((e) => (
            <div key={e.claim} className="flex flex-col gap-1">
              <dt className="text-18 font-medium text-balance">{e.claim}</dt>
              <dd className="text-14 text-text-2">{e.detail}</dd>
            </div>
          ))}
        </dl>
        <p className="text-13 text-text-3">
          The numbers come from <span className="font-mono">docs/METRICS.md</span> in the
          repository, with the caveats written next to them. The{' '}
          <Link href="/status" className="underline underline-offset-4 hover:text-text">
            status page
          </Link>{' '}
          shows the same system live.
        </p>
      </section>

      <section aria-labelledby="things" className="flex flex-col gap-6">
        <h2 id="things" className="text-22 font-semibold">
          Three things, one account
        </h2>
        <ul className="grid gap-8 md:grid-cols-3">
          {THINGS.map((t) => (
            <li key={t.name} className="flex flex-col gap-2">
              <h3 className="text-18 font-semibold">
                <Link href={t.href} className="hover:underline">
                  {t.name}
                </Link>
              </h3>
              <p className="text-14 text-text-2">{t.text}</p>
            </li>
          ))}
        </ul>
      </section>
    </div>
  );
}
