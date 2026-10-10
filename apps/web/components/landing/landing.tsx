'use client';
import Link from 'next/link';
import { Button } from '@/components/ui/button';
import { signInHref, useSession } from '@/lib/session';
import { JudgeWindow } from './judge-window';
import { SampleBoard } from './sample-board';
import { VerdictMix } from './verdict-mix';
import { VerdictTicker } from './verdict-ticker';

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

/**
 * Every number here is in `docs/METRICS.md`, with the run and date named in the sentence and the caveat
 * METRICS.md writes beside it. Nothing on this page is a customer count, a quote or an estimate (PRODUCT.md:
 * absent evidence is not invented). The only live numbers are in the ticker, which shows real verdicts or nothing.
 */
const EVIDENCE = [
  {
    value: '2.1 s',
    claim: 'A verdict, at the 95th percentile.',
    detail:
      'Load test on production, 8 October 2026: 500 submissions in two minutes, two judge machines, 195 of 200 live listeners connected, on light test problems (a heavier problem takes longer).',
  },
  {
    value: '28',
    claim: 'Attack programs, all contained.',
    detail:
      'Fork bombs, memory bombs, symlink and /proc reads, network, ptrace, chroot escapes. They run against a real judge machine every night.',
  },
  {
    value: '6',
    claim: 'Failure drills pass on production.',
    detail:
      'Redis killed outright, among others: every accepted submission still got exactly one verdict.',
  },
  {
    value: '2.1 ms',
    claim: 'For a keystroke to reach the other typists, at the 95th percentile.',
    detail:
      'Interview pad, run of 9 October 2026: thirty people typing in ten rooms at once, the target 200 ms, nothing lost or doubled. Measured on one machine, without a network.',
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
    <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-20 py-6 md:py-14">
      <section
        aria-labelledby="hero"
        className="grid items-center gap-10 lg:grid-cols-[1.15fr_1fr] lg:gap-14"
      >
        <div className="flex flex-col gap-6">
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
        </div>
        <JudgeWindow />
      </section>

      <VerdictTicker />

      <section aria-labelledby="evidence" className="flex flex-col gap-8">
        <h2 id="evidence" className="max-w-[36rem] text-22 font-semibold">
          Measured, with the run behind each number
        </h2>
        <dl className="grid gap-x-12 gap-y-10 md:grid-cols-2">
          {EVIDENCE.map((e) => (
            <div key={e.claim} className="flex flex-col gap-2">
              <dt className="flex flex-col gap-1">
                <span className="display font-mono text-40 font-semibold md:text-56">
                  {e.value}
                </span>
                <span className="text-16 font-medium text-balance">{e.claim}</span>
              </dt>
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

      <VerdictMix />

      <SampleBoard />

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
