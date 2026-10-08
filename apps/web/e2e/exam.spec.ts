import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { stubAdmin } from './stub-admin';
import { stubApi } from './stub-api';
import { stubContests } from './stub-contests';

const EXAM = { startsInSec: -30 * 60, durationMin: 180, registered: true, exam: true };
const ID = '11111111-1111-4111-8111-111111111111';

/** A browser without the Fullscreen API: the test then runs on visibility and focus alone. */
const noFullscreen = (page: Page) =>
  page.addInitScript(() => {
    Object.defineProperty(Element.prototype, 'requestFullscreen', { value: undefined });
  });
const leaveWindow = (page: Page) => page.evaluate(() => window.dispatchEvent(new Event('blur')));
const hideTab = (page: Page) =>
  page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
  });
const settle = (page: Page) => page.waitForTimeout(2100); // past the 2 s coalescing window

async function examArena(page: Page, opts: Parameters<typeof stubContests>[1] = EXAM) {
  await noFullscreen(page);
  await stubApi(page);
  const st = await stubContests(page, opts);
  await page.goto('/c/warm-up-1/A');
  return st;
}
const start = async (page: Page) => {
  await page.getByRole('button', { name: 'Start the test' }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'A. Chai Bill' })).toBeVisible();
};

test.describe('C-10: exam mode (FR-EXAM-01..05)', () => {
  test('FR-EXAM-01: a contest with exam mode opens at a gate that lists the rules', async ({
    page,
  }) => {
    await examArena(page);
    await expect(
      page.getByRole('heading', { level: 1, name: 'CodeArena Warm-up #1' }),
    ).toBeVisible();
    await expect(
      page.getByText('two warnings, and the 3rd time your test is submitted'),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'A. Chai Bill' })).toHaveCount(0);
    await start(page);
    await expect(page.getByRole('button', { name: 'Finish test' })).toBeVisible();
  });

  test('FR-EXAM-01: a normal contest has no gate and no Finish button', async ({ page }) => {
    await examArena(page, { ...EXAM, exam: false });
    await expect(page.getByRole('heading', { level: 1, name: 'A. Chai Bill' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Finish test' })).toHaveCount(0);
    await leaveWindow(page);
    await page.waitForTimeout(300);
    await expect(page.getByRole('dialog')).toHaveCount(0);
  });

  test('FR-EXAM-02: two warnings, then the third leave submits the test', async ({ page }) => {
    const st = await examArena(page);
    await start(page);

    await leaveWindow(page);
    const w1 = page.getByRole('dialog', { name: 'Warning 1 of 2' });
    await expect(w1).toBeVisible();
    await expect(w1).toContainText('You left the test window.');
    await page.keyboard.press('Escape'); // a warning is not dismissed by accident
    await expect(w1).toBeVisible();
    await w1.getByRole('button', { name: 'Continue the test' }).click();
    await expect(w1).toHaveCount(0);

    await settle(page);
    await hideTab(page);
    const w2 = page.getByRole('dialog', { name: 'Warning 2 of 2' });
    await expect(w2).toBeVisible();
    await expect(w2).toContainText('next time, your test is submitted');
    await w2.getByRole('button', { name: 'Continue the test' }).click();

    await settle(page);
    await leaveWindow(page);
    await expect(page.getByRole('heading', { name: 'Your test was submitted' })).toBeVisible();
    await expect(page.getByText('You left the test window 3 times')).toBeVisible();
    expect(st.exam).toMatchObject({ strikes: 3, finishReason: 'left-window' });
    await expect(page.getByRole('link', { name: 'Open the scoreboard' })).toBeVisible();
  });

  test('FR-EXAM-02: blur and visibilitychange together, and events during a warning, count once', async ({
    page,
  }) => {
    const st = await examArena(page);
    await start(page);
    await leaveWindow(page);
    await hideTab(page);
    await leaveWindow(page);
    await expect(page.getByRole('dialog', { name: 'Warning 1 of 2' })).toBeVisible();
    expect(st.exam.leaves).toBe(1);
    expect(st.exam.strikes).toBe(1);
  });

  test('FR-EXAM-02: leaving before "Start the test" counts for nothing', async ({ page }) => {
    const st = await examArena(page);
    await expect(page.getByRole('button', { name: 'Start the test' })).toBeVisible();
    await leaveWindow(page);
    await hideTab(page);
    await page.waitForTimeout(300);
    expect(st.exam.leaves).toBe(0);
  });

  test('FR-EXAM-02: leaving full screen counts as leaving the window', async ({ page }) => {
    await page.addInitScript(() => {
      let current: Element | null = null;
      Object.defineProperty(document, 'fullscreenElement', { get: () => current });
      Element.prototype.requestFullscreen = function () {
        current = document.documentElement; // the page asks on the root element
        document.dispatchEvent(new Event('fullscreenchange'));
        return Promise.resolve();
      };
      document.exitFullscreen = () => {
        current = null;
        document.dispatchEvent(new Event('fullscreenchange'));
        return Promise.resolve();
      };
      (window as unknown as { escapeFullscreen: () => void }).escapeFullscreen = () => {
        void document.exitFullscreen();
      };
    });
    await stubApi(page);
    const st = await stubContests(page, EXAM);
    await page.goto('/c/warm-up-1/A');
    await start(page);
    expect(st.exam.leaves).toBe(0); // entering full screen is not leaving
    await page.evaluate(() =>
      (window as unknown as { escapeFullscreen: () => void }).escapeFullscreen(),
    );
    await expect(page.getByRole('dialog', { name: 'Warning 1 of 2' })).toBeVisible();
    expect(st.exam.strikes).toBe(1);
  });

  test('FR-EXAM-01: Finish test asks first, then there is no way back in', async ({ page }) => {
    const st = await examArena(page);
    await start(page);
    await page.getByRole('button', { name: 'Finish test' }).click();
    const confirm = page.getByRole('dialog', { name: 'Finish the test?' });
    await confirm.getByRole('button', { name: 'Keep working' }).click();
    expect(st.exam.finishes).toBe(0);
    await page.getByRole('button', { name: 'Finish test' }).click();
    await page.getByRole('dialog').getByRole('button', { name: 'Finish the test' }).click();
    await expect(page.getByRole('heading', { name: 'You finished the test' })).toBeVisible();
    expect(st.exam).toMatchObject({ finishes: 1, finishReason: 'self' });

    // Coming back (reload, or the link again) lands on the finished screen: the server refuses the problems.
    await page.reload();
    await expect(page.getByRole('heading', { name: 'You finished the test' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'A. Chai Bill' })).toHaveCount(0);
  });

  test('FR-EXAM-03: a reload during the test shows the gate again, keeps the strikes, adds none', async ({
    page,
  }) => {
    const st = await examArena(page);
    await start(page);
    await leaveWindow(page);
    await page.getByRole('button', { name: 'Continue the test' }).click();
    await page.reload();
    await expect(page.getByText('You have already left the window 1 time.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Resume the test' })).toBeVisible();
    expect(st.exam.leaves).toBe(1);
    await page.getByRole('button', { name: 'Resume the test' }).click();
    await expect(page.getByRole('heading', { level: 1, name: 'A. Chai Bill' })).toBeVisible();
  });

  test('FR-EXAM-03: the contest page states the exam rules, and a finished test', async ({
    page,
  }) => {
    await stubApi(page);
    const st = await stubContests(page, EXAM);
    await page.goto('/c/warm-up-1');
    await expect(page.getByText(/^Exam mode: you enter once/)).toBeVisible();
    st.exam.finishedAt = new Date().toISOString();
    st.exam.finishReason = 'left-window';
    await page.reload();
    await expect(
      page.getByText('Your test was submitted after you left the window 3 times'),
    ).toBeVisible();
  });

  test('FR-EXAM-03: after the contest ends the arena is a normal one again', async ({ page }) => {
    await examArena(page, {
      startsInSec: -300 * 60,
      durationMin: 120,
      registered: true,
      exam: true,
    });
    await expect(page.getByRole('heading', { level: 1, name: 'A. Chai Bill' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Finish test' })).toHaveCount(0);
  });

  for (const size of [
    { width: 1280, height: 800 },
    { width: 390, height: 800 },
  ]) {
    test(`the gate, a warning and the finished screen have no violations at ${size.width}px`, async ({
      page,
    }) => {
      await page.setViewportSize(size);
      await examArena(page);
      const check = async (what: string) => {
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
          `${what} overflows`,
        ).toBeLessThanOrEqual(0);
        const r = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .exclude('.monaco-editor')
          .analyze();
        expect(r.violations, what).toEqual([]);
      };
      await check('gate');
      await start(page);
      await leaveWindow(page);
      await expect(page.getByRole('dialog', { name: 'Warning 1 of 2' })).toBeVisible();
      await check('warning');
      await page.getByRole('button', { name: 'Continue the test' }).click();
      await page.getByRole('button', { name: 'Finish test' }).click();
      await page.getByRole('dialog').getByRole('button', { name: 'Finish the test' }).click();
      await expect(page.getByRole('heading', { name: 'You finished the test' })).toBeVisible();
      await check('finished');
    });
  }
});

test.describe('C-10: ops console, exam list and Reopen (FR-EXAM-05)', () => {
  test('lists who left or finished, and Reopen gives the test back', async ({ page }) => {
    await stubApi(page, { role: 'admin' });
    await stubAdmin(page);
    const st = await stubContests(page, EXAM);
    st.exam.others = [
      {
        userId: 'u9',
        handle: 'amy',
        leaveCount: 3,
        finishedAt: new Date().toISOString(),
        finishReason: 'left-window',
      },
      { userId: 'u8', handle: 'zed', leaveCount: 1, finishedAt: null, finishReason: null },
    ];
    await page.goto(`/admin/contests/${ID}/ops`);
    const section = page.getByRole('region', { name: /Exam mode/ });
    await expect(section).toContainText('amy');
    await expect(section).toContainText('Submitted after leaving');
    await expect(section.getByRole('row', { name: /zed/ })).toContainText('In progress');
    await section.getByRole('button', { name: 'Reopen the test of amy' }).click();
    await expect.poll(() => st.exam.reopened).toEqual(['u9']);
    await expect(section.getByRole('row', { name: /amy/ })).toContainText('In progress');
  });

  test('a contest without exam mode has no Exam section', async ({ page }) => {
    await stubApi(page, { role: 'admin' });
    await stubAdmin(page);
    await stubContests(page, { ...EXAM, exam: false });
    await page.goto(`/admin/contests/${ID}/ops`);
    await expect(page.getByRole('heading', { name: /operations/ })).toBeVisible();
    await expect(page.getByRole('region', { name: /Exam mode/ })).toHaveCount(0);
  });
});
