import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { stubAdmin } from './stub-admin';
import { stubApi } from './stub-api';
import { stubContests } from './stub-contests';

const ID = '11111111-1111-4111-8111-111111111111';

test.describe('C-01: contest list (S07)', () => {
  test('sections, and registering from the list', async ({ page }) => {
    await stubApi(page);
    const st = await stubContests(page);
    await page.goto('/contests');
    await expect(page.getByRole('heading', { name: 'Contests', level: 1 })).toBeVisible();
    const running = page.getByRole('region', { name: 'Running now' });
    await expect(running).toContainText('Live Now Cup');
    await expect(running.getByRole('link', { name: 'Enter Live Now Cup' })).toBeVisible();
    const upcoming = page.getByRole('region', { name: 'Upcoming' });
    await expect(upcoming).toContainText('CodeArena Warm-up #1');
    await expect(upcoming).toContainText('12 registered');
    await expect(upcoming).toContainText('IST');
    await expect(page.getByRole('region', { name: 'Past' })).toContainText('Old One');
    await upcoming.getByRole('button', { name: 'Register for CodeArena Warm-up #1' }).click();
    await expect.poll(() => st.registers).toEqual(['warm-up-1']);
    await expect(upcoming.getByText('Registered')).toBeVisible();
  });

  test('a guest sees no Register button, only the links', async ({ page }) => {
    await stubApi(page, { signedIn: false });
    await stubContests(page);
    await page.goto('/contests');
    await expect(page.getByRole('region', { name: 'Upcoming' })).toContainText('Warm-up #1');
    await expect(page.getByRole('button', { name: /Register/ })).toHaveCount(0);
  });
});

test.describe('C-01: contest lobby (S08)', () => {
  test('FR-CONT-03: the countdown follows the server clock, not the browser clock', async ({
    page,
  }) => {
    await stubApi(page);
    // The server thinks it is an hour later than the browser does; the contest starts in 1 h by
    // the server's clock. A countdown from the browser clock would show 02:00:00.
    await stubContests(page, { startsInSec: 3600, clockSkewMs: 3_600_000 });
    await page.goto('/c/warm-up-1');
    await expect(
      page.getByRole('heading', { name: 'CodeArena Warm-up #1', level: 1 }),
    ).toBeVisible();
    await expect(page.getByText('Starts in')).toBeVisible();
    await expect(page.getByText(/^00:5[89]:\d\d$|^01:00:00$/)).toBeVisible();
  });

  test('rules, times in IST, problem count, registered count', async ({ page }) => {
    await stubApi(page);
    await stubContests(page);
    await page.goto('/c/warm-up-1');
    await expect(page.getByText('Six problems, two hours. Good luck!')).toBeVisible();
    const rules = page.getByRole('region', { name: 'Rules' });
    await expect(rules).toContainText('plus 20 for each rejected attempt');
    await expect(rules).toContainText('Compile errors do not count');
    await expect(rules).toContainText('Python 3 ×3');
    await expect(page.getByText('2 h', { exact: true })).toBeVisible();
    await expect(page.getByText(/IST/).first()).toBeVisible();
    await expect(page.getByText('30 min before the end')).toBeVisible();
  });

  test('registering flips the button to "You are registered"', async ({ page }) => {
    await stubApi(page);
    const st = await stubContests(page);
    await page.goto('/c/warm-up-1');
    await page.getByRole('button', { name: 'Register' }).click();
    await expect(page.getByText('You are registered')).toBeVisible();
    expect(st.registers).toEqual(['warm-up-1']);
  });

  test('a guest is sent to sign in', async ({ page }) => {
    await stubApi(page, { signedIn: false });
    await stubContests(page);
    await page.goto('/c/warm-up-1');
    const link = page.getByRole('link', { name: 'Sign in to register' });
    await expect(link).toHaveAttribute('href', /\/signin\?.*return/);
  });

  test('Add to calendar downloads an .ics with the start and end', async ({ page }) => {
    await stubApi(page);
    await stubContests(page);
    await page.goto('/c/warm-up-1');
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('button', { name: 'Add to calendar' }).click(),
    ]);
    expect(download.suggestedFilename()).toBe('warm-up-1.ics');
    const text = await (
      await download.createReadStream()
    )
      .toArray()
      .then((c) => Buffer.concat(c).toString());
    expect(text).toContain('BEGIN:VEVENT');
    expect(text).toMatch(/DTSTART:\d{8}T\d{6}Z/);
    expect(text).toMatch(/DTEND:\d{8}T\d{6}Z/);
    expect(text).toContain('SUMMARY:CodeArena Warm-up #1');
  });

  test('US-4.2: at the start the lobby opens without a reload and announces it', async ({
    page,
  }) => {
    await stubApi(page);
    await stubContests(page, { startsInSec: 4, registered: true });
    await page.goto('/c/warm-up-1');
    await expect(page.getByText('Starts in')).toBeVisible();
    await expect(page.getByRole('region', { name: 'Problems' })).toHaveCount(0);
    await expect(page.getByText('Ends in')).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole('status').filter({ hasText: 'Contest started' })).toHaveCount(1);
    const problems = page.getByRole('region', { name: 'Problems' });
    await expect(problems).toContainText('Chai Bill', { timeout: 10_000 });
    await expect(problems).toContainText('Lantern Lighting');
  });

  test('FR-PROB-09: a running contest shows no problems until you register', async ({ page }) => {
    await stubApi(page);
    await stubContests(page, { startsInSec: -600 });
    await page.goto('/c/warm-up-1');
    await expect(
      page.getByText('Register to see the problems while the contest runs.'),
    ).toBeVisible();
    await expect(page.getByText('Chai Bill')).toHaveCount(0);
    await page.getByRole('button', { name: 'Register' }).click();
    await expect(page.getByRole('region', { name: 'Problems' })).toContainText('Chai Bill');
  });

  test('with late registration off, a running contest says registration is closed', async ({
    page,
  }) => {
    await stubApi(page);
    await stubContests(page, { startsInSec: -600, noLateRegistration: true });
    await page.goto('/c/warm-up-1');
    await expect(page.getByText('Registration closed when the contest started.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Register' })).toBeDisabled();
  });

  test('an unknown contest says so', async ({ page }) => {
    await stubApi(page);
    await page.route('**/api/contests/nope', (r) =>
      r.fulfill({
        status: 404,
        contentType: 'application/problem+json',
        body: JSON.stringify({
          type: 'https://codearena.dev/errors/not-found',
          title: 'Not found',
          status: 404,
          code: 'not-found',
        }),
      }),
    );
    await page.goto('/c/nope');
    await expect(page.getByText('No such contest.')).toBeVisible();
  });
});

async function adminSetup(page: Page, opts: Parameters<typeof stubContests>[1] = {}) {
  await stubApi(page, { role: 'admin' });
  await stubAdmin(page);
  return stubContests(page, opts);
}

test.describe('C-01: admin contests (FR-CONT-01, FR-AUTH-09)', () => {
  test('a setter may not manage contests; the Contests tab is for admins', async ({ page }) => {
    await stubApi(page, { role: 'setter' });
    await stubAdmin(page);
    await stubContests(page);
    await page.goto('/admin/contests');
    await expect(page.getByRole('heading', { name: 'Not allowed' })).toBeVisible();
    await page.goto('/admin/problems');
    await expect(
      page
        .getByRole('link', { name: 'Contests', exact: true })
        .and(page.locator('[aria-label="Admin sections"] a')),
    ).toHaveCount(0);
  });

  test('create a draft: times, freeze minutes and slug go to the API', async ({ page }) => {
    const st = await adminSetup(page);
    await page.goto('/admin/contests');
    await page.getByLabel('Title').fill('CodeArena Warm-up #1');
    await expect(page.getByLabel('Slug (the link: /c/…)')).toHaveValue('codearena-warm-up-1');
    await page.getByLabel('Starts').fill('2026-10-10T19:00');
    await page.getByLabel('Ends').fill('2026-10-10T21:00');
    await page.getByRole('button', { name: 'Create draft' }).click();
    await expect(page).toHaveURL(new RegExp(`/admin/contests/${ID}$`));
    expect(st.created).toHaveLength(1);
    const body = st.created[0] as {
      slug: string;
      startsAt: string;
      endsAt: string;
      freezeAt: string;
    };
    expect(body.slug).toBe('codearena-warm-up-1');
    expect(Date.parse(body.endsAt) - Date.parse(body.startsAt)).toBe(120 * 60_000);
    expect(Date.parse(body.endsAt) - Date.parse(body.freezeAt)).toBe(30 * 60_000);
  });

  test('set the problem list, then publish; the registration link appears', async ({ page }) => {
    const st = await adminSetup(page);
    await page.goto(`/admin/contests/${ID}`);
    await expect(
      page.getByRole('heading', { name: 'CodeArena Warm-up #1', level: 1 }),
    ).toBeVisible();
    await page.getByRole('button', { name: 'Add problem' }).click();
    await page.getByLabel('Problem', { exact: true }).selectOption('hop-distances');
    await page.getByRole('button', { name: 'Save problem list' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Problem list saved.' })).toBeVisible();
    expect(st.problemPuts).toEqual([{ items: [{ label: 'A', slug: 'hop-distances' }] }]);
    await page.getByRole('button', { name: 'Publish' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Published.' })).toBeVisible();
    await expect(page.getByRole('link', { name: /\/c\/warm-up-1$/ })).toBeVisible();
    await page.getByRole('button', { name: 'Unpublish (back to draft)' }).click();
    await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeVisible();
    expect(st.patches.map((p) => p.published)).toEqual([true, false]);
  });

  test('FR-EXAM-01: ticking Exam mode sends it in the rules; it is off by default', async ({
    page,
  }) => {
    const st = await adminSetup(page);
    await page.goto(`/admin/contests/${ID}`);
    const box = page.getByLabel(/^Exam mode:/);
    await expect(box).not.toBeChecked();
    await box.check();
    await page.getByRole('button', { name: 'Save details' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Details saved.' })).toBeVisible();
    expect((st.patches.at(-1) as { rules: { examMode: boolean } }).rules.examMode).toBe(true);
  });

  test('FR-PROB-05: a refused publish lists the problem that is not validated', async ({
    page,
  }) => {
    await adminSetup(page, { publishError: true });
    await page.goto(`/admin/contests/${ID}`);
    await page.getByRole('button', { name: 'Publish' }).click();
    const alert = page.getByRole('alert').filter({ hasText: 'must pass validation' });
    await expect(alert).toContainText('problems.hop-distances');
    await expect(alert).toContainText('run Validate');
  });

  test('saving details sends the rules and the freeze', async ({ page }) => {
    const st = await adminSetup(page);
    await page.goto(`/admin/contests/${ID}`);
    await page.getByLabel('Penalty per rejected attempt (minutes)').fill('10');
    await page.getByLabel('Compile errors count as rejected attempts').check();
    await page.getByRole('button', { name: 'Save details' }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Details saved.' })).toBeVisible();
    const sent = st.patches.at(-1) as {
      rules: { penaltyMinutes: number; ceCountsAsAttempt: boolean };
      freezeAt: string;
      endsAt: string;
    };
    expect(sent.rules.penaltyMinutes).toBe(10);
    expect(sent.rules.ceCountsAsAttempt).toBe(true);
    expect(Date.parse(sent.endsAt) - Date.parse(sent.freezeAt)).toBe(30 * 60_000);
  });
});

for (const theme of ['dark', 'light'] as const) {
  for (const size of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`C-01 a11y: contests screens, ${theme}, ${size.width}px, no page-level horizontal scroll`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({
        viewport: size,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      await stubApi(page, { role: 'admin' });
      await stubAdmin(page);
      await stubContests(page, { startsInSec: 7200 });
      const check = async (what: string) => {
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
          `${what} overflows the page`,
        ).toBeLessThanOrEqual(0);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        const serious = results.violations.filter(
          (v) => v.impact === 'serious' || v.impact === 'critical',
        );
        expect(
          serious.map(
            (v) => `${what} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
          ),
        ).toEqual([]);
      };
      await page.goto('/contests');
      await expect(page.getByRole('region', { name: 'Upcoming' })).toBeVisible();
      await check('list');
      await page.goto('/c/warm-up-1');
      await expect(page.getByText('Starts in')).toBeVisible();
      await check('lobby');
      await page.goto('/admin/contests');
      await expect(page.getByRole('heading', { name: 'New contest' })).toBeVisible();
      await check('admin list');
      await page.goto(`/admin/contests/${ID}`);
      await expect(page.getByRole('heading', { name: 'Details' })).toBeVisible();
      await check('admin editor');
      await ctx.close();
    });
  }
}
