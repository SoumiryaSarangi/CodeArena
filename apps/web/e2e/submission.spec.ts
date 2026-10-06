import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { emit, progress, sseUrls, stubApi } from './stub-api';

const T0 = Date.parse('2026-10-06T10:00:00.000Z');
const iso = (ms: number) => new Date(T0 + ms).toISOString();

const SOURCE =
  '#include <bits/stdc++.h>\nint main(){long long a,b;std::cin>>a>>b;std::cout<<a+b;}\n';
const base = {
  id: 'D1',
  problemSlug: 'sum-two-numbers',
  problemTitle: 'Two Numbers, One Total',
  language: 'cpp17',
  status: 'done',
  verdict: 'AC',
  timeMs: 40,
  memKb: 2048,
  failedTest: null,
  lane: 'practice',
  createdAt: iso(0),
  source: SOURCE,
  problemVersion: 1,
  runVersion: 1,
  compileLog: null,
  tests: [1, 2, 3].map((no) => ({
    no,
    verdict: 'AC',
    timeMs: no * 3,
    memKb: 1500,
    checkerMsg: null,
  })),
  journey: {
    submittedAt: iso(0),
    judgedAt: iso(4200),
    workerId: 'judge-2',
    steps: [
      { phase: 'claimed', at: iso(1800) },
      { phase: 'compiling', at: iso(1900) },
      { phase: 'running', at: iso(3500) },
      { phase: 'done', at: iso(4100) },
    ],
  },
};

const editorReady = (page: Page) =>
  page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 60_000 });

test('UI-03: an accepted submission: header, journey with times, tests, and the read-only code', async ({
  page,
}) => {
  const { state } = await stubApi(page);
  state.details.D1 = base;
  await page.goto('/s/D1');
  await expect(
    page.getByRole('heading', { name: 'Submission to Two Numbers, One Total' }),
  ).toBeAttached();
  await expect(page.getByText('Accepted', { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Two Numbers, One Total' })).toHaveAttribute(
    'href',
    '/p/sum-two-numbers',
  );
  await expect(page.getByText('C++17')).toBeVisible();
  await expect(page.getByText('40 ms').first()).toBeVisible();

  const journey = page.getByRole('region', { name: 'Journey' });
  for (const label of ['Submitted', 'Claimed', 'Compiled', 'Tests', 'Verdict published'])
    await expect(journey.getByText(label, { exact: true })).toBeVisible();
  await expect(journey.getByText('by judge-2')).toBeVisible();
  await expect(journey.getByText('in 1.6 s')).toBeVisible();
  await expect(journey.getByText('+1.8 s')).toBeVisible();
  await expect(journey.getByText('+4.2 s')).toBeVisible();
  await expect(journey.locator('time').nth(1)).toHaveAttribute('title', /\d/); // absolute time on hover

  const tests = page.getByRole('region', { name: 'Tests' });
  await expect(tests.getByRole('row')).toHaveCount(4); // header + 3
  await expect(tests.getByRole('row').nth(2)).toContainText('AC');

  await editorReady(page);
  expect(
    (await page.locator('.monaco-editor .view-lines').first().innerText()).replace(/\u00a0/g, ' '),
  ).toContain('std::cin>>a>>b');
  await expect(page.getByLabel('Submitted code, C++17 (read only)')).toBeAttached();
});

test('UI-03: a wrong answer highlights the first failing test; a checker message shows only where the API sent one', async ({
  page,
}) => {
  const { state } = await stubApi(page);
  state.details.D2 = {
    ...base,
    id: 'D2',
    verdict: 'WA',
    failedTest: 2,
    tests: [
      { no: 1, verdict: 'AC', timeMs: 3, memKb: 1500, checkerMsg: null },
      { no: 2, verdict: 'WA', timeMs: 4, memKb: 1500, checkerMsg: 'expected 5, found 4' },
      { no: 3, verdict: 'WA', timeMs: 4, memKb: 1500, checkerMsg: null },
    ],
  };
  await page.goto('/s/D2');
  await expect(page.getByText('Wrong answer on test 2').first()).toBeVisible();
  const tests = page.getByRole('region', { name: 'Tests' });
  const failing = tests.getByRole('row').filter({ hasText: 'first failing test' });
  await expect(failing).toHaveCount(1);
  await expect(failing).toContainText('expected 5, found 4');
  await expect(tests.getByRole('row').nth(3)).not.toContainText('first failing');
  await expect(
    page.getByRole('region', { name: 'Journey' }).getByText('1 passed, stopped at test 2'),
  ).toBeVisible();
});

test('UI-03: a compile error shows the compiler output and no test table', async ({ page }) => {
  const { state } = await stubApi(page);
  state.details.D3 = {
    ...base,
    id: 'D3',
    verdict: 'CE',
    tests: [],
    timeMs: 0,
    memKb: 0,
    compileLog: "main.cpp:1:1: error: expected ';'",
    journey: { ...base.journey, steps: base.journey.steps.slice(0, 2) },
  };
  await page.goto('/s/D3');
  await expect(page.getByText('Compilation error').first()).toBeVisible();
  await expect(page.getByRole('region', { name: 'Compiler output' })).toContainText("expected ';'");
  await expect(page.getByRole('region', { name: 'Tests' })).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Journey' }).getByText('Compilation failed'),
  ).toBeVisible();
});

test('UI-03: with no recorded timings it says so instead of inventing steps', async ({ page }) => {
  const { state } = await stubApi(page);
  state.details.D4 = { ...base, id: 'D4', journey: { ...base.journey, steps: [] } };
  await page.goto('/s/D4');
  const journey = page.getByRole('region', { name: 'Journey' });
  await expect(
    journey.getByText('Step timings were not recorded for this submission.'),
  ).toBeVisible();
  await expect(journey.getByText('Claimed')).toHaveCount(0);
  await expect(journey.getByText('Verdict published')).toBeVisible();
});

test('UI-03: "Resubmit in editor" opens the problem with this code in the editor', async ({
  page,
}) => {
  const { state } = await stubApi(page);
  state.details.D1 = {
    ...base,
    language: 'python3',
    source: 'print(sum(map(int, input().split())))\n',
  };
  await page.goto('/s/D1');
  await page.getByRole('button', { name: 'Resubmit in editor' }).click();
  await expect(page).toHaveURL(/\/p\/sum-two-numbers$/);
  await editorReady(page);
  await expect(page.getByLabel('Language')).toHaveValue('python3');
  await expect
    .poll(async () =>
      (await page.locator('.monaco-editor .view-lines').first().innerText()).replace(
        /\u00a0/g,
        ' ',
      ),
    )
    .toContain('print(sum(map(int, input().split())))');
});

test('UI-03: someone else’s or an unknown submission is "not found", with no hint that it exists', async ({
  page,
}) => {
  await stubApi(page);
  await page.goto('/s/not-mine');
  await expect(page.getByRole('heading', { name: 'Submission not found' })).toBeVisible();
  await expect(page.getByText('It may not exist, or it is not yours to see.')).toBeVisible();
  await expect(page.getByText('forbidden', { exact: false })).toHaveCount(0);
});

test('UI-03: a guest is asked to sign in and returns here afterwards', async ({ page }) => {
  await stubApi(page, { signedIn: false });
  await page.goto('/s/D1');
  await expect(page.getByText('Sign in to see this submission.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Sign in' }).last()).toHaveAttribute(
    'href',
    '/signin?returnTo=%2Fs%2FD1',
  );
});

test('UI-03: a submission still being judged updates live and shows the verdict when it arrives', async ({
  page,
}) => {
  const { state } = await stubApi(page);
  state.details.L1 = {
    ...base,
    id: 'L1',
    status: 'queued',
    verdict: null,
    timeMs: null,
    memKb: null,
    tests: [],
    journey: { submittedAt: iso(0), judgedAt: null, workerId: null, steps: [] },
  };
  await page.goto('/s/L1');
  await expect(page.getByText('judging…')).toBeVisible();
  await expect.poll(() => sseUrls(page).then((u) => u.some((x) => x.includes('L1')))).toBe(true);
  await emit(page, 'L1', 'submission.progress', '1-0', progress('L1', 'claimed'));
  await expect(page.getByText('Judging on judge-2', { exact: true })).toBeVisible();
  await emit(
    page,
    'L1',
    'submission.progress',
    '1-1',
    progress('L1', 'running', { test: { no: 1, verdict: 'AC', timeMs: 3, memKb: 1000 } }),
  );
  await expect(page.getByRole('listitem', { name: /Test 1 · AC/ })).toBeVisible();

  state.details.L1 = { ...base, id: 'L1' }; // what the API answers once judged
  await emit(page, 'L1', 'submission.verdict', '1-2', {
    submissionId: 'L1',
    runVersion: 1,
    status: 'done',
    verdict: 'AC',
    timeMs: 40,
    memKb: 2048,
    failedTest: null,
  });
  await expect(page.getByText('Accepted', { exact: true })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Tests' })).toBeVisible();
  await expect(page.getByRole('region', { name: 'Journey' }).getByText('by judge-2')).toBeVisible();
  await expect(page.getByRole('region', { name: 'Progress' })).toHaveCount(0);
});

test('UI-03: admins also see the judge and every judging run; other users do not', async ({
  page,
}) => {
  const { state } = await stubApi(page, { role: 'admin' });
  state.details.D1 = {
    ...base,
    runs: [
      {
        runVersion: 1,
        reason: 'initial',
        workerId: 'judge-2',
        verdict: 'WA',
        finishedAt: iso(4200),
      },
      {
        runVersion: 2,
        reason: 'rejudge',
        workerId: 'judge-3',
        verdict: 'AC',
        finishedAt: iso(900000),
      },
    ],
  };
  await page.goto('/s/D1');
  const admin = page.getByRole('region', { name: 'Admin details' });
  await expect(admin.getByText('judge-2').first()).toBeVisible();
  const table = admin.getByRole('table', { name: 'Judging runs' });
  await expect(table.getByRole('row')).toHaveCount(3);
  await expect(table.getByRole('row').nth(2)).toContainText('rejudge');

  const other = await page.context().newPage();
  await stubApi(other);
  await other.route(/\/api\/submissions\/D1$/, (r) => r.fulfill({ json: base }));
  await other.goto('/s/D1');
  await expect(other.getByText('Accepted', { exact: true })).toBeVisible();
  await expect(other.getByRole('region', { name: 'Admin details' })).toHaveCount(0);
});

for (const [width, height] of [
  [1280, 900],
  [390, 844],
] as const) {
  for (const theme of ['dark', 'light'] as const) {
    test(`UI-03: /s/<id> at ${width}px in ${theme} is accessible with no page-level horizontal scroll`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({
        viewport: { width, height },
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      const { state } = await stubApi(page);
      state.details.D2 = {
        ...base,
        id: 'D2',
        verdict: 'WA',
        failedTest: 2,
        tests: [
          { no: 1, verdict: 'AC', timeMs: 3, memKb: 1500, checkerMsg: null },
          { no: 2, verdict: 'WA', timeMs: 4, memKb: 1500, checkerMsg: 'expected 5, found 4' },
        ],
      };
      await page.goto('/s/D2');
      await expect(page.getByRole('region', { name: 'Journey' })).toBeVisible();
      await editorReady(page).catch(() => {});
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .exclude('.monaco-editor')
        .analyze();
      const serious = results.violations.filter(
        (v) => v.impact === 'serious' || v.impact === 'critical',
      );
      expect(
        serious.map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      ).toEqual([]);
      await ctx.close();
    });
  }
}
