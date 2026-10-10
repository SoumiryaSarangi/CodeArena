'use client';
import Link from 'next/link';
import { CirclePause, CloudOff } from 'lucide-react';
import { demoPaused, useServerState } from '@/lib/server-state';

export const REPO_URL = 'https://github.com/SoumiryaSarangi/CodeArena';

export const NOTICE_COPY = {
  paused: {
    title: 'CodeArena is paused.',
    body: 'The servers are switched off between showcases to save cloud credits, so sign-in, problems, contests and interview rooms are unavailable. It will be back online for the next showcase.',
  },
  unreachable: {
    title: "Can't reach the server right now.",
    body: 'Sign-in, problems, contests and interview rooms need it, so they may show errors. This page checks again every few seconds and this notice goes away by itself.',
  },
} as const;

/** Presentational part, so the wording can be tested without a browser. */
export function ServerNoticeBar({ mode }: { mode: keyof typeof NOTICE_COPY }) {
  const copy = NOTICE_COPY[mode];
  const Icon = mode === 'paused' ? CirclePause : CloudOff;
  return (
    <div role="status" className="border-b border-border bg-surface-2">
      <div className="mx-auto flex max-w-[1440px] items-start gap-3 px-4 py-3 text-14 md:px-6">
        <Icon className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
        <p className="text-text-2">
          <span className="font-semibold text-text">{copy.title}</span> {copy.body}
          {mode === 'paused' ? (
            <>
              {' '}
              <Link href="/status#how" className="text-accent underline">
                How it works
              </Link>
              {' · '}
              <a href={REPO_URL} className="text-accent underline">
                Source code
              </a>
            </>
          ) : null}
        </p>
      </div>
    </div>
  );
}

/** A bar under the top bar of every page while the API does not answer (UI-23). */
export function ServerNotice() {
  const state = useServerState();
  if (state !== 'down') return null;
  return <ServerNoticeBar mode={demoPaused() ? 'paused' : 'unreachable'} />;
}
