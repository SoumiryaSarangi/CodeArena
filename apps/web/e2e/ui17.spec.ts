import { expect, test } from '@playwright/test';
import { emit, progress, runVerdict, stubApi } from './stub-api';

const editorReady = (page: import('@playwright/test').Page) =>
  page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 60_000 });

test('UI-17 S05: the wire under Submit follows the real events and settles into the verdict colour; the strip says it in words', async ({
  page,
}) => {
  await stubApi(page);
  await page.goto('/p/sum-two-numbers');
  await editorReady(page);
  await expect(page.locator('[data-wire]')).toHaveCount(0); // nothing submitted yet
  await page.getByRole('button', { name: /^Submit/ }).click();
  const wire = page.locator('[role="toolbar"] [data-wire]');
  await expect(wire).toHaveAttribute('data-wire', /^(submitting|queued)$/);
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __sse: unknown }).__sse !== undefined))
    .toBe(true);
  await emit(page, 'S1', 'submission.progress', '2-0', progress('S1', 'claimed'));
  await expect(wire).toHaveAttribute('data-wire', 'claimed');
  await emit(page, 'S1', 'submission.progress', '2-1', progress('S1', 'compiling'));
  await expect(wire).toHaveAttribute('data-wire', 'compiling');
  await emit(page, 'S1', 'submission.verdict', '3-0', runVerdict('S1', 'AC'));
  await expect(wire).toHaveAttribute('data-wire', 'AC');
  expect(await wire.locator('span.bg-v-ac').count()).toBe(5); // all five segments settled in the AC colour
  await expect(page.getByText('5 ms', { exact: true }).first()).toBeVisible(); // the strip's time
});

test('UI-17 S03: every recent submission has its wire, settled in its verdict', async ({
  page,
}) => {
  await stubApi(page);
  await page.goto('/home');
  await expect(page.getByRole('heading', { level: 2, name: 'Recent submissions' })).toBeVisible();
  await expect(page.locator('[data-wire="WA"]').first()).toBeVisible();
});

test('UI-17: a rated account has its handle in the tier colour with the tier word; a new 1400 account stays neutral', async ({
  page,
}) => {
  await stubApi(page, { rating: 1650 });
  await page.goto('/home');
  const link = page.getByRole('banner').getByRole('link', { name: /riya_k/ });
  await expect(link.locator('span.text-tier-expert')).toBeVisible();
  await expect(link).toContainText('Expert'); // read out, not colour alone
  const fresh = await page.context().newPage();
  await stubApi(fresh); // 1400: the starting rating
  await fresh.goto('/home');
  await expect(fresh.getByRole('banner').locator('[class*="text-tier-"]')).toHaveCount(0);
});

test('UI-17 S04: difficulty is a word with a tone, and the list says how many are solved', async ({
  page,
}) => {
  await stubApi(page);
  await page.route('**/api/problems?**', (r) =>
    r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        items: [
          {
            slug: 'a',
            title: 'Peak Reading',
            difficulty: 800,
            tags: [],
            practicePoints: 8,
            acceptance: 90,
            status: 'solved',
          },
          {
            slug: 'b',
            title: 'Maze Runner',
            difficulty: 1200,
            tags: [],
            practicePoints: 12,
            acceptance: 40,
            status: 'new',
          },
          {
            slug: 'c',
            title: 'Spell Fixer',
            difficulty: 1600,
            tags: [],
            practicePoints: 16,
            acceptance: 12,
            status: 'new',
          },
        ],
        nextCursor: null,
      }),
    }),
  );
  await page.goto('/practice');
  await expect(page.locator('td span.text-diff-easy:visible', { hasText: 'Easy' })).toBeVisible();
  await expect(
    page.locator('td span.text-diff-medium:visible', { hasText: 'Medium' }),
  ).toBeVisible();
  await expect(page.locator('td span.text-diff-hard:visible', { hasText: 'Hard' })).toBeVisible();
  await expect(page.getByText('3 problems · 1 solved')).toBeVisible();
});

test('UI-17 S06: a long list with a failure shows the failing rows first, the rest one tap away; big numbers read as numbers', async ({
  page,
}) => {
  const { state } = await stubApi(page);
  state.details.D1 = {
    id: 'D1',
    problemSlug: 'sum-two-numbers',
    problemTitle: 'Two Numbers, One Total',
    language: 'cpp17',
    status: 'done',
    verdict: 'WA',
    timeMs: 99_999,
    memKb: 2_097_152, // 2 GB
    failedTest: 3,
    lane: 'practice',
    createdAt: '2026-10-06T10:00:00.000Z',
    source: 'int main(){}\n',
    problemVersion: 1,
    runVersion: 1,
    compileLog: null,
    tests: Array.from({ length: 20 }, (_, i) => ({
      no: i + 1,
      verdict: i === 2 ? 'WA' : 'AC',
      timeMs: i,
      memKb: 1500,
      checkerMsg: null,
    })),
    journey: { submittedAt: '2026-10-06T10:00:00.000Z', judgedAt: null, workerId: null, steps: [] },
  };
  await page.goto('/s/D1');
  await expect(page.getByText('99,999 ms').first()).toBeVisible();
  await expect(page.getByText('2.0 GB').first()).toBeVisible();
  const tests = page.getByRole('region', { name: 'Test results table' });
  await expect(tests.getByRole('row')).toHaveCount(2); // header + the one wrong test
  await expect(page.getByText('19 of 20 tests passed')).toBeVisible();
  await page.getByRole('button', { name: 'Show all 20 tests' }).click();
  await expect(tests.getByRole('row')).toHaveCount(21);
});

test('UI-17 S02: the sign-in page says what happens next', async ({ page }) => {
  await stubApi(page, { signedIn: false });
  await page.goto('/signin');
  await expect(page.getByRole('heading', { level: 2, name: 'After you sign in' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Continue with Google' })).toBeVisible();
});
