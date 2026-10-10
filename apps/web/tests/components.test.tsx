import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { timerTone } from '@/components/timer';
import { VerdictBadge } from '@/components/verdict-badge';
import { VerdictGrid, type GridTest } from '@/components/verdict-grid';
import { Button, IconButton } from '@/components/ui/button';
import { EmptyState, ErrorState } from '@/components/ui/states';
import { formatDuration, formatMemKb } from '@/lib/format';
import { VERDICTS, verdictTitle } from '@/lib/verdicts';
import { Verdict } from '@codearena/contracts';

describe('F-07: verdict presentation', () => {
  it('FR-JUDGE-05: every verdict has copy, a text label and a colour', () => {
    expect(Object.keys(VERDICTS).sort()).toEqual([...Verdict.options].sort());
    for (const v of Verdict.options) expect(VERDICTS[v].label).toBe(v);
  });

  it('F-07: "on test N" only appears for per-test verdicts (SRS Appendix A)', () => {
    expect(verdictTitle('WA', 7)).toBe('Wrong answer on test 7');
    expect(verdictTitle('CE', 7)).toBe('Compilation error');
    expect(verdictTitle('AC', 7)).toBe('Accepted');
  });

  it('F-07: badges always carry the text label, never colour alone', () => {
    for (const v of Verdict.options)
      expect(renderToStaticMarkup(<VerdictBadge verdict={v} />)).toContain(`>${v}<`);
    expect(renderToStaticMarkup(<VerdictBadge verdict="WA" test={7} />)).toContain('on test 7');
    expect(renderToStaticMarkup(<VerdictBadge verdict="pending" />)).toContain('judging');
  });
});

describe('F-07: verdict grid', () => {
  const tests: GridTest[] = [
    { no: 1, state: 'AC', timeMs: 12, memKb: 2048 },
    { no: 2, state: 'WA', timeMs: 31, memKb: 2150 },
    { no: 3, state: 'running' },
    { no: 4, state: 'pending' },
  ];
  const html = renderToStaticMarkup(
    <VerdictGrid tests={tests} finalAnnouncement="Test 2 wrong answer" />,
  );

  it('F-07: renders a labelled list with one focusable item per test and a tooltip text', () => {
    expect(html).toContain('role="list"');
    expect(html.match(/role="listitem"/g)).toHaveLength(4);
    expect(html.match(/tabindex="0"/g)).toHaveLength(4);
    expect(html).toContain('Test 2 · WA (Wrong answer) · 31 ms · 2.1 MB');
  });

  it('F-07: only the final verdict goes to the live region', () => {
    expect(html).toContain('aria-live="polite"');
    expect(html.match(/aria-live/g)).toHaveLength(1);
    expect(html).toContain('Test 2 wrong answer');
  });
});

describe('F-07: timer and formatting', () => {
  it('F-07: tone switches at 5 minutes and 60 seconds (UI_UX §7)', () => {
    expect(timerTone(301)).toBe('normal');
    expect(timerTone(300)).toBe('warning');
    expect(timerTone(61)).toBe('warning');
    expect(timerTone(60)).toBe('danger');
    expect(timerTone(0)).toBe('danger');
  });

  it('F-07: durations and sizes follow UI_UX §10.5', () => {
    expect(formatDuration(6727)).toBe('01:52:07');
    expect(formatDuration(-5)).toBe('00:00:00');
    expect(formatMemKb(2150)).toBe('2.1 MB');
    expect(formatMemKb(512)).toBe('512 KB');
    expect(formatMemKb(2_097_152)).toBe('2.0 GB'); // UI-17: not 2048.0 MB
  });
});

describe('F-07: base components', () => {
  it('F-07: a loading button is disabled, busy and keeps its label for width', () => {
    const html = renderToStaticMarkup(<Button loading>Submit</Button>);
    expect(html).toContain('disabled');
    expect(html).toContain('aria-busy="true"');
    expect(html).toContain('Submit');
  });

  it('F-07: error state is an alert with retry and request id; empty state has one action', () => {
    const err = renderToStaticMarkup(<ErrorState requestId="7f3a91c2" onRetry={() => {}} />);
    expect(err).toContain('role="alert"');
    expect(err).toContain('Ref: 7f3a91c2');
    expect(err).toContain('Try again');
    expect(
      renderToStaticMarkup(<EmptyState message="Nothing here." action={<Button>Go</Button>} />),
    ).toContain('Go');
  });
});

describe('F-07: class merging', () => {
  it('F-07: a text colour survives next to a custom font-size class', async () => {
    const { cn } = await import('@/lib/cn');
    expect(cn('text-accent-fg', 'text-14')).toBe('text-accent-fg text-14');
    expect(cn('text-13', 'text-14')).toBe('text-14');
    expect(cn('text-text-2', 'text-text')).toBe('text-text');
  });

  it('F-07: primary and danger buttons keep their foreground colour', () => {
    expect(renderToStaticMarkup(<Button variant="primary">x</Button>)).toContain('text-primary-fg');
    expect(renderToStaticMarkup(<Button variant="accent">x</Button>)).toContain('text-accent-fg');
    expect(renderToStaticMarkup(<Button variant="danger">x</Button>)).toContain('text-bg');
  });

  it('UI-09: the primary button is ink on paper, not the accent', () => {
    const html = renderToStaticMarkup(<Button variant="primary">x</Button>);
    expect(html).toContain('bg-primary');
    expect(html).not.toContain('bg-accent');
  });

  it('UI-09: small buttons and icon buttons carry a 44 px hit area on touch (AUDIT 2)', () => {
    expect(renderToStaticMarkup(<Button size="sm">x</Button>)).toContain('hit-44');
    expect(renderToStaticMarkup(<IconButton label="Close">x</IconButton>)).toContain('hit-44');
  });
});
