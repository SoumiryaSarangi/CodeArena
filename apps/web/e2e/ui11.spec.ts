import { expect, test } from '@playwright/test';
import { stubApi } from './stub-api';

const detail = (tests: number) => ({
  id: 'D1',
  problemSlug: 'sum-two-numbers',
  problemTitle: 'A problem title that is far too long for a heading and wraps over several lines',
  language: 'cpp17',
  status: 'done',
  verdict: 'WA',
  timeMs: 99_999,
  memKb: 2_147_483_647,
  failedTest: 3,
  lane: 'practice',
  createdAt: '2026-10-06T10:00:00.000Z',
  source: 'int main(){}\n',
  problemVersion: 1,
  runVersion: 1,
  compileLog: null,
  tests: Array.from({ length: tests }, (_, i) => ({
    no: i + 1,
    verdict: i === 2 ? 'WA' : 'AC',
    timeMs: i * 17,
    memKb: 1500,
    checkerMsg: i === 2 ? 'expected 123456789012345678 found 123456789012345679 '.repeat(3) : null,
  })),
  journey: { submittedAt: '2026-10-06T10:00:00.000Z', judgedAt: null, workerId: null, steps: [] },
});

test('UI-11 S06: one visible h1, larger than the section headings, and one date format (AUDIT 7, 13)', async ({
  page,
}) => {
  const { state } = await stubApi(page);
  state.details.D1 = detail(3);
  await page.goto('/s/D1');
  const h1 = page.getByRole('heading', { level: 1 });
  await expect(h1).toContainText('Submission to');
  await expect(h1).toBeVisible();
  const size = (loc: typeof h1) => loc.evaluate((e) => parseFloat(getComputedStyle(e).fontSize));
  const h2 = page.getByRole('heading', { level: 2, name: 'Journey' });
  expect((await size(h1)) / (await size(h2))).toBeGreaterThanOrEqual(1.25);
  // 6 Oct 2026, not 10/6/2026 (US order) and not a mix of formats
  await expect(page.getByText(/\b6 Oct 2026, \d{2}:\d{2}/)).toBeVisible();
});

test('UI-11 S06: 60 tests with long values keep numbers on one line and the page narrow on a phone (AUDIT 12)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const { state } = await stubApi(page);
  state.details.D1 = detail(60);
  await page.goto('/s/D1');
  await expect(page.getByRole('row')).toHaveCount(61);
  const wrapping = await page
    .locator('td.font-mono.text-right')
    .evaluateAll(
      (cells) => cells.filter((c) => getComputedStyle(c).whiteSpace !== 'nowrap').length,
    );
  expect(wrapping).toBe(0); // a long message in one row may stretch it, but never splits "17 ms"
  expect(
    await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
  ).toBeLessThanOrEqual(0);
});

test('UI-11 S05: on a phone the Run/Submit bar sits above the bottom navigation, not under it (AUDIT 12)', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page);
  await page.goto('/p/sum-two-numbers');
  const bar = await page.getByRole('button', { name: 'Submit' }).evaluate((b) => {
    const r = (b.parentElement as HTMLElement).getBoundingClientRect();
    return { bottom: r.bottom };
  });
  const nav = await page.getByRole('navigation', { name: 'Main' }).boundingBox();
  expect(bar.bottom).toBeLessThanOrEqual(nav!.y + 0.5);
});
