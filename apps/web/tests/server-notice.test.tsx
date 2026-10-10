import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { NOTICE_COPY, REPO_URL, ServerNoticeBar } from '@/components/shell/server-notice';
import { probeOnce } from '@/lib/server-state';

const res = (status: number) => (async () => ({ status })) as unknown as typeof fetch;

describe('UI-23: the notice shown while the servers do not answer', () => {
  it('UI-23: the paused notice says why, what is unavailable and links to how it works and the source', () => {
    const html = renderToStaticMarkup(<ServerNoticeBar mode="paused" />);
    expect(html).toContain('role="status"');
    expect(html).toContain('CodeArena is paused.');
    expect(html).toContain('save cloud credits');
    for (const w of ['sign-in', 'problems', 'contests', 'interview rooms'])
      expect(html).toContain(w);
    expect(html).toContain('href="/status#how"');
    expect(html).toContain(`href="${REPO_URL}"`);
  });

  it('UI-23: the unreachable notice does not claim the demo is paused', () => {
    const html = renderToStaticMarkup(<ServerNoticeBar mode="unreachable" />);
    expect(html).toContain('Can&#x27;t reach the server right now.');
    expect(html).not.toContain('paused');
    expect(html).not.toContain('credits');
    expect(NOTICE_COPY.unreachable.body).toContain('goes away by itself');
  });

  it('UI-23: the server counts as up for anything but a 5xx answer, and as down for a 5xx or a failed request', async () => {
    expect(await probeOnce(res(200))).toBe(true);
    expect(await probeOnce(res(401))).toBe(true);
    expect(await probeOnce(res(404))).toBe(true);
    expect(await probeOnce(res(500))).toBe(false);
    expect(await probeOnce(res(502))).toBe(false);
    expect(await probeOnce(res(504))).toBe(false);
    expect(
      await probeOnce((async () =>
        Promise.reject(new Error('refused'))) as unknown as typeof fetch),
    ).toBe(false);
  });

  it('UI-23: a request that never answers is given up on after the timeout', async () => {
    const hang = ((_: unknown, init?: { signal?: AbortSignal }) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })) as unknown as typeof fetch;
    expect(await probeOnce(hang, 20)).toBe(false);
  });
});
