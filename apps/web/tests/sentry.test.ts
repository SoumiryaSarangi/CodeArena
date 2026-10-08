import * as Sentry from '@sentry/nextjs';
import { describe, expect, it } from 'vitest';
import { startSentry } from '../lib/sentry';

describe('O-01: browser error tracking', () => {
  it('NFR-OBS-03: no DSN, nothing starts', () => {
    expect(startSentry(undefined, 'test')).toBe(false);
    expect(Sentry.getClient()).toBeUndefined();
  });

  it('NFR-OBS-03: with a DSN, events lose the request and the user before they are sent', () => {
    expect(startSentry('https://public@example.invalid/1', 'test')).toBe(true);
    const hook = Sentry.getClient()!.getOptions().beforeSend!;
    const event = {
      request: { url: 'https://x/c/a/A', data: 'int main(){}' },
      user: { email: 'a@b.c' },
      message: 'm',
    } as unknown as Sentry.ErrorEvent;
    const out = hook(event, {}) as Sentry.Event;
    expect(out.request).toBeUndefined();
    expect(out.user).toBeUndefined();
    expect(out.message).toBe('m');
  });
});
