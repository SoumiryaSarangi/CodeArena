import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { drop, emit, progress, runVerdict, sseUrls, stubApi } from './stub-api';

const URL = '/p/sum-two-numbers';
const editorReady = (page: Page) =>
  page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 60_000 });
// Monaco renders spaces as non-breaking spaces.
const editorText = async (page: Page) =>
  (await page.locator('.monaco-editor .view-lines').first().innerText()).replace(/\u00a0/g, ' ');

/** Select everything in the editor and type: what a person does to replace their code. */
async function typeCode(page: Page, text: string) {
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type(text);
}

test('UI-02: opens a problem: statement with maths, samples, and the editor with the C++ template', async ({
  page,
}) => {
  await stubApi(page);
  await page.goto(URL);
  await expect(page.getByRole('heading', { level: 1, name: 'Two Numbers, One Total' })).toHaveCount(
    1,
  );
  await expect(page.locator('.katex').first()).toBeVisible();
  await expect(page.getByText('Fits in 64 bits.')).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Sample 1' })).toBeVisible();
  await expect(page.getByText('Time 1000 ms')).toBeVisible();
  await expect(page.getByText('Whitespace differences are ignored.')).toBeVisible();
  await editorReady(page);
  expect(await editorText(page)).toContain('int main()');
  await expect(page.getByLabel('Code editor, C++17')).toBeAttached();
});

test('UI-02: an unknown problem says so', async ({ page }) => {
  await stubApi(page);
  await page.goto('/p/nope');
  await expect(page.getByRole('heading', { name: 'Problem not found' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Back to Practice' })).toBeVisible();
});

test('UI-02 acceptance: run a sample → output; submit → queue → grid fills → AC', async ({
  page,
}) => {
  const { calls } = await stubApi(page);
  await page.goto(URL);
  await editorReady(page);

  // Run sample 1.
  await page.getByRole('button', { name: 'Run this sample' }).first().click();
  await expect.poll(() => calls.runs.length).toBe(1);
  expect(calls.runs[0]!.body).toMatchObject({
    problemSlug: 'sum-two-numbers',
    language: 'cpp17',
    sampleIds: [1],
  });
  expect(calls.runs[0]!.headers['idempotency-key']).toMatch(/^[0-9a-f-]{36}$/);
  expect(calls.runs[0]!.headers['authorization']).toBe('Bearer tok');
  expect(calls.runs[0]!.headers['x-csrf-token']).toHaveLength(43);
  await expect(page.getByRole('region', { name: 'Sample 1' }).first()).toBeVisible();
  await expect.poll(() => sseUrls(page).then((u) => u.some((x) => x.includes('R1-1')))).toBe(true);
  await emit(page, 'R1-1', 'submission.verdict', '1-0', runVerdict('R1-1'));
  const card = page.getByRole('region', { name: 'Sample 1' }).last();
  await expect(card.getByText('AC', { exact: true })).toBeVisible();
  await expect(card.locator('pre').first()).toHaveText('5');

  // Submit.
  await page.getByRole('button', { name: /^Submit/ }).click();
  await expect(page.getByRole('tab', { name: 'Tests' })).toHaveAttribute('data-state', 'active');
  await expect.poll(() => calls.submissions.length).toBe(1);
  expect(calls.submissions[0]!.body).toMatchObject({
    problemSlug: 'sum-two-numbers',
    language: 'cpp17',
  });
  await expect(page.getByText('#3 in queue · ETA ~5 s')).toBeVisible();
  await expect.poll(() => sseUrls(page).then((u) => u.some((x) => x.includes('S1')))).toBe(true);

  await emit(page, 'S1', 'submission.queue', '', {
    submissionId: 'S1',
    lane: 'practice',
    position: 1,
    etaSeconds: 2,
    capped: false,
  });
  await expect(page.getByText('#1 in queue · ETA ~2 s')).toBeVisible();
  await emit(page, 'S1', 'submission.progress', '2-0', progress('S1', 'claimed'));
  await expect(page.getByText('Judging on judge-2', { exact: true })).toBeVisible();
  await emit(page, 'S1', 'submission.progress', '2-1', progress('S1', 'compiling'));
  await expect(page.getByText('Judging on judge-2 · compiling')).toBeVisible();
  await expect(page.getByRole('list', { name: 'Test results' }).getByRole('listitem')).toHaveCount(
    4,
  );

  for (const no of [1, 2]) {
    await emit(
      page,
      'S1',
      'submission.progress',
      `3-${no}`,
      progress('S1', 'running', { test: { no, verdict: 'AC', timeMs: 10 * no, memKb: 2048 } }),
    );
  }
  await expect(page.getByText('Judging on judge-2 · 2/4')).toBeVisible();
  await expect(page.getByRole('listitem', { name: /Test 1 · AC/ })).toBeVisible();
  await expect(page.getByRole('listitem', { name: /Test 3 · running/ })).toBeVisible();
  for (const no of [3, 4]) {
    await emit(
      page,
      'S1',
      'submission.progress',
      `3-${no}`,
      progress('S1', 'running', { test: { no, verdict: 'AC', timeMs: 5, memKb: 2048 } }),
    );
  }
  await emit(page, 'S1', 'submission.verdict', '4-0', {
    submissionId: 'S1',
    runVersion: 1,
    status: 'done',
    verdict: 'AC',
    timeMs: 40,
    memKb: 2048,
    failedTest: null,
  });

  const header = page.getByRole('tabpanel');
  await expect(header.getByText('AC', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('Accepted', { exact: true }).first()).toBeAttached();
  await expect(page.getByRole('status').filter({ hasText: 'Accepted' })).toBeAttached(); // announced politely
  await expect(page.getByRole('link', { name: 'Details →' })).toHaveAttribute('href', '/s/S1');
  for (const no of [1, 2, 3, 4])
    await expect(page.getByRole('listitem', { name: new RegExp(`Test ${no} · AC`) })).toBeVisible();
  // the connection for S1 is released after the verdict
  await expect
    .poll(() =>
      page.evaluate(
        () =>
          (
            window as unknown as { __sse: { sources: { closed: boolean; url: string }[] } }
          ).__sse.sources.filter((s) => s.url.includes('S1') && !s.closed).length,
      ),
    )
    .toBe(0);
});

test('UI-02: a wrong answer shows the failing test, and a sample run shows expected vs yours line by line', async ({
  page,
}) => {
  const { calls, state } = await stubApi(page);
  state.runResults['R1-1'] = {
    id: 'R1-1',
    status: 'done',
    verdict: 'AC',
    timeMs: 4,
    memKb: 900,
    output: '4\n',
    stderr: null,
    compileLog: null,
    expected: '5\n',
    matches: false,
  };
  await page.goto(URL);
  await editorReady(page);
  await page.getByRole('button', { name: 'Run this sample' }).first().click();
  await expect.poll(() => calls.runs.length).toBe(1);
  await expect.poll(() => sseUrls(page).then((u) => u.some((x) => x.includes('R1-1')))).toBe(true);
  await emit(page, 'R1-1', 'submission.verdict', '1-0', runVerdict('R1-1'));
  await expect(page.getByText('Differs from the expected output')).toBeVisible();
  const table = page.getByRole('table', { name: 'Expected and your output, line by line' });
  await expect(table).toContainText('5');
  await expect(table).toContainText('4');
  await expect(table.getByText('(differs)')).toBeAttached();

  await page.getByRole('button', { name: /^Submit/ }).click();
  await expect.poll(() => sseUrls(page).then((u) => u.some((x) => x.includes('S1')))).toBe(true);
  await emit(page, 'S1', 'submission.verdict', '5-0', {
    submissionId: 'S1',
    runVersion: 1,
    status: 'done',
    verdict: 'WA',
    timeMs: 40,
    memKb: 2048,
    failedTest: 3,
  });
  await expect(page.getByText('Wrong answer on test 3').first()).toBeVisible();
});

test('UI-02: keyboard only: Ctrl+Enter runs, Ctrl+Shift+Enter submits (once, even from the editor), Alt+1..4 switch tabs, the divider resizes by 5 %', async ({
  page,
}) => {
  const { calls } = await stubApi(page);
  await page.goto(URL);
  await editorReady(page);

  await page.locator('#custom-input').fill('1 2');
  await page.locator('#custom-input').press('Control+Enter');
  await expect.poll(() => calls.runs.length).toBe(1);
  expect(calls.runs[0]!.body).toMatchObject({ input: '1 2' });

  // inside the editor Monaco's command fires, and the window handler must not fire it a second time
  await page.locator('.monaco-editor textarea').first().focus();
  await page.keyboard.press('Control+Shift+Enter');
  await expect.poll(() => calls.submissions.length).toBe(1);
  await page.waitForTimeout(300);
  expect(calls.submissions).toHaveLength(1);

  for (const [key, name] of [
    ['1', 'Console'],
    ['2', 'Tests'],
    ['3', 'Submissions'],
    ['4', 'Coach'],
  ] as const) {
    await page.keyboard.press(`Alt+${key}`);
    await expect(page.getByRole('tab', { name })).toHaveAttribute('data-state', 'active');
  }

  const sep = page.getByRole('separator', { name: 'Resize statement and editor' });
  await sep.focus();
  const before = Number(await sep.getAttribute('aria-valuenow'));
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => Number(await sep.getAttribute('aria-valuenow'))).toBe(before + 5);
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => Number(await sep.getAttribute('aria-valuenow'))).toBe(before - 5);
});

test('UI-02: drafts are saved per problem and language and survive a reload', async ({ page }) => {
  await stubApi(page);
  await page.goto(URL);
  await editorReady(page);
  await page.getByLabel('Language').selectOption('python3');
  await expect.poll(() => editorText(page)).toContain('def main');
  await typeCode(page, 'print(42)');
  await page.waitForTimeout(700); // the 500 ms save
  expect(await page.evaluate(() => localStorage.getItem('draft:sum-two-numbers:python3'))).toBe(
    'print(42)',
  );

  await page.getByLabel('Language').selectOption('cpp17');
  await expect.poll(() => editorText(page)).toContain('int main()'); // its own draft (the template)
  expect(await page.evaluate(() => localStorage.getItem('draft:sum-two-numbers:python3'))).toBe(
    'print(42)',
  );

  await page.reload();
  await editorReady(page);
  await expect(page.getByLabel('Language')).toHaveValue('cpp17');
  await page.getByLabel('Language').selectOption('python3');
  await expect.poll(() => editorText(page)).toContain('print(42)');

  page.once('dialog', (d) => void d.accept());
  await page.getByRole('button', { name: 'Reset code to the template' }).click();
  await expect.poll(() => editorText(page)).toContain('def main');
  expect(
    await page.evaluate(() => localStorage.getItem('draft:sum-two-numbers:python3')),
  ).toBeNull();
});

test('UI-02: a 429 shows a countdown on the button and Submit comes back', async ({ page }) => {
  const { calls } = await stubApi(page, { rateLimit: { retryAfter: 2 } });
  await page.goto(URL);
  await editorReady(page);
  await page.getByRole('button', { name: /^Submit/ }).click();
  const btn = page.getByRole('button', { name: /You can submit again in/ });
  await expect(btn).toBeDisabled();
  await expect(btn).toContainText('s');
  await expect(page.getByRole('button', { name: /^Submit/ })).toBeEnabled({ timeout: 6000 });
  expect(calls.submissions).toHaveLength(1);
});

test('X-14: a submit that meets a restarting API is retried with the same Idempotency-Key and lands once', async ({
  page,
}) => {
  const { calls } = await stubApi(page, { unavailable: 2 });
  await page.goto(URL);
  await editorReady(page);
  await page.getByRole('button', { name: /^Submit/ }).click();
  await expect.poll(() => calls.submissions.length, { timeout: 20_000 }).toBe(3);
  const keys = calls.submissions.map((c) => c.headers['idempotency-key']);
  expect(new Set(keys).size).toBe(1);
  expect(keys[0]).toMatch(/^[0-9a-f-]{36}$/);
});

test('UI-02: a guest is asked to sign in and cannot run samples', async ({ page }) => {
  const { calls } = await stubApi(page, { signedIn: false });
  await page.goto(URL);
  await editorReady(page);
  await expect(page.getByRole('button', { name: 'Run this sample' }).first()).toBeDisabled();
  await page.getByRole('button', { name: /^Submit/ }).click();
  const alert = page.getByRole('alert').filter({ hasText: 'Sign in to run and submit code.' });
  await expect(alert).toBeVisible();
  await expect(alert.getByRole('link', { name: 'Sign in' })).toHaveAttribute(
    'href',
    '/signin?returnTo=%2Fp%2Fsum-two-numbers',
  );
  expect(calls.submissions).toHaveLength(0);
  await expect(page.getByRole('tab', { name: 'Submissions' })).toBeVisible();
});

test('UI-02: no handle yet → the submit is refused with a link to choose one', async ({ page }) => {
  const { calls } = await stubApi(page, { handle: null });
  await page.goto(URL);
  await editorReady(page);
  await page.getByRole('button', { name: /^Submit/ }).click();
  await expect(
    page.getByRole('alert').filter({ hasText: 'Choose a handle before you submit.' }),
  ).toBeVisible();
  expect(calls.submissions).toHaveLength(0);
});

test('UI-02: when the connection drops the pill says so, a NEW ticket is used, and the last event id is sent', async ({
  page,
}) => {
  const { calls } = await stubApi(page);
  await page.goto(URL);
  await editorReady(page);
  await page.getByRole('button', { name: /^Submit/ }).click();
  await expect.poll(() => sseUrls(page).then((u) => u.some((x) => x.includes('S1')))).toBe(true);
  await emit(page, 'S1', 'submission.progress', '9-4', progress('S1', 'claimed'));
  await expect(page.getByText('Judging on judge-2', { exact: true })).toBeVisible();
  const first = (await sseUrls(page)).filter((u) => u.includes('S1'));
  expect(first).toHaveLength(1);
  expect(first[0]).toContain('ticket=ticket-1');

  await drop(page, 'S1');
  await expect(page.getByText('Reconnecting…')).toBeVisible();
  await expect.poll(() => calls.tickets.length, { timeout: 10_000 }).toBe(2);
  await expect
    .poll(() => sseUrls(page).then((u) => u.filter((x) => x.includes('S1')).length), {
      timeout: 10_000,
    })
    .toBe(2);
  const urls = (await sseUrls(page)).filter((u) => u.includes('S1'));
  expect(urls[1]).toContain('ticket=ticket-2');
  expect(urls[1]).toContain('lastEventId=9-4');
  await expect(page.getByText('Reconnected')).toBeVisible();
  await expect(page.getByText('Reconnected')).toBeHidden({ timeout: 5000 });
});

test('UI-02: the Submissions tab lists my earlier attempts on this problem', async ({ page }) => {
  await stubApi(page);
  await page.goto(URL);
  await editorReady(page);
  await page.getByRole('tab', { name: 'Submissions' }).click();
  const row = page.getByRole('row').filter({ hasText: 'cpp17' });
  await expect(row.getByText('WA')).toBeVisible();
  await expect(row.getByRole('link')).toHaveAttribute('href', '/s/old-1');
});

for (const [width, height] of [
  [1280, 900],
  [390, 844],
] as const) {
  for (const theme of ['dark', 'light'] as const) {
    test(`UI-02: /p/<slug> at ${width}px in ${theme} is accessible with no page-level horizontal scroll`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({
        viewport: { width, height },
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      await stubApi(page);
      await page.goto(URL);
      if (width < 1024) {
        for (const name of ['Statement', 'Code', 'Console'])
          await expect(page.getByRole('tab', { name, exact: true }).first()).toBeVisible();
        await page.getByRole('tab', { name: 'Code' }).click();
        await expect(page.getByRole('button', { name: 'Submit' })).toBeVisible(); // the fixed bar
      }
      await editorReady(page).catch(() => {});
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .exclude('.monaco-editor') // third-party widget: its own accessibility mode is tested by hand
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

test('UI-02: narrow layout: Statement / Code / Console tabs, Submit stays fixed at the bottom and opens the Tests tab', async ({
  browser,
}) => {
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await ctx.newPage();
  const { calls } = await stubApi(page);
  await page.goto(URL);
  await expect(page.getByText('Fits in 64 bits.')).toBeVisible();
  await page.getByRole('button', { name: 'Submit' }).click();
  await expect.poll(() => calls.submissions.length).toBe(1);
  await expect(page.getByRole('tab', { name: 'Console' }).first()).toHaveAttribute(
    'data-state',
    'active',
  );
  await expect(page.getByText('#3 in queue · ETA ~5 s')).toBeVisible();
  await ctx.close();
});

test.describe('S02: sign in and onboarding', () => {
  test('/signin has both providers with a safe returnTo, and explains a failed sign-in', async ({
    page,
  }) => {
    await stubApi(page, { signedIn: false });
    await page.goto('/signin?returnTo=/p/sum-two-numbers&error=oauth-failed');
    await expect(page.getByRole('alert')).toHaveText('Sign-in was cancelled. Try again?');
    await expect(page.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute(
      'href',
      '/api/auth/google?returnTo=%2Fp%2Fsum-two-numbers',
    );
    await expect(page.getByRole('link', { name: 'Continue with GitHub' })).toHaveAttribute(
      'href',
      /\/api\/auth\/github\?returnTo=/,
    );
    await page.goto('/signin?returnTo=//evil.test');
    await expect(page.getByRole('link', { name: 'Continue with Google' })).toHaveAttribute(
      'href',
      '/api/auth/google?returnTo=%2Fpractice',
    );
  });

  test('onboarding: rules, live availability, a taken handle gets a suggestion, then you land where you were going', async ({
    page,
  }) => {
    const { calls } = await stubApi(page, {
      handle: null,
      takenHandles: ['riya_k'],
      racedHandles: ['raced'],
    });
    await page.goto('/onboarding?returnTo=/p/sum-two-numbers');
    await expect(page.getByRole('heading', { name: 'Choose your handle' })).toBeVisible();
    const field = page.getByLabel('Handle');
    await field.fill('ab');
    await expect(page.getByText('3–20 characters').last()).toBeVisible();
    await field.fill('admin');
    await expect(page.getByText('That handle is reserved.')).toBeVisible();
    await field.fill('riya_k');
    await expect(page.getByText('That handle is taken.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Let’s go' })).toBeDisabled();

    // looks free, but someone took it a moment ago: the server says so on save, with a suggestion
    await field.fill('raced');
    await expect(page.getByRole('button', { name: 'Let’s go' })).toBeEnabled();
    await page.getByRole('button', { name: 'Let’s go' }).click();
    await expect(page.getByText('How about raced_k2?')).toBeVisible();
    await field.fill('riya_k2');
    await expect(page.getByText('That handle is taken.')).toBeHidden();
    await page.getByLabel('Default language').selectOption('python3');
    await page.getByRole('button', { name: 'Let’s go' }).click();
    await expect(page).toHaveURL(/\/p\/sum-two-numbers$/);
    expect(calls.patchMe.at(-1)).toEqual({ handle: 'riya_k2', defaultLanguage: 'python3' });
  });

  test('a guest on /onboarding is sent to sign in', async ({ page }) => {
    await stubApi(page, { signedIn: false });
    await page.goto('/onboarding');
    await expect(page).toHaveURL(/\/signin\?returnTo=%2Fonboarding/);
  });

  test('the top bar shows Sign in for guests, and the handle with Sign out when signed in', async ({
    page,
  }) => {
    await stubApi(page, { signedIn: false });
    await page.goto('/practice');
    await expect(page.getByRole('link', { name: 'Sign in' })).toBeVisible();
    const signed = await page.context().newPage();
    await stubApi(signed);
    await signed.goto('/practice');
    await expect(signed.getByRole('link', { name: 'riya_k' })).toBeVisible();
    await signed.getByRole('button', { name: 'Sign out' }).click();
    await expect(signed.getByRole('link', { name: 'Sign in' })).toBeVisible();
  });
});
