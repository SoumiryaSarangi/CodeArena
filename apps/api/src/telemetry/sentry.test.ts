import * as Sentry from '@sentry/node';
import { describe, expect, it } from 'vitest';
import { reportError, startSentry } from './sentry';

describe('O-01: error tracking', () => {
  it('NFR-OBS-03: without a DSN nothing is started and reporting is harmless', () => {
    startSentry(undefined, 'test');
    expect(Sentry.getClient()).toBeUndefined();
    expect(() => reportError(new Error('boom'), 'req-1')).not.toThrow();
  });

  it('NFR-OBS-03: events carry the request id and never the request or the user', async () => {
    const sent: Sentry.Event[] = [];
    startSentry('https://public@example.invalid/1', 'test');
    const client = Sentry.getClient()!;
    // Capture what would be sent after the privacy hook ran, without any network.
    const before = client.getOptions().beforeSend!;
    client.getOptions().beforeSend = (e, h) => {
      const out = before(e, h) as Sentry.Event;
      sent.push(out);
      return null;
    };
    Sentry.captureException(new Error('boom'), {
      tags: { requestId: 'req-1' },
      user: { email: 'a@b.c' },
      contexts: { request: { data: 'source code' } },
    });
    Sentry.getCurrentScope().setUser({ email: 'a@b.c' });
    reportError(new Error('boom 2'), 'req-2');
    await Sentry.flush(500);
    expect(sent.length).toBeGreaterThanOrEqual(2);
    for (const e of sent) {
      expect(e.request).toBeUndefined();
      expect(e.user).toBeUndefined();
    }
    // Events may be processed in any order: look for ours by its tag.
    expect(sent.some((e) => e.tags?.requestId === 'req-2')).toBe(true);
    await Sentry.close(0);
  });
});
