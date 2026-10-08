import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { stubApi } from './stub-api';
import { stubContests } from './stub-contests';

async function open(
  page: Page,
  path: string,
  tweak?: (s: Record<string, Record<string, unknown>>) => void,
  opts = {},
) {
  const { state } = await stubApi(page, opts);
  await stubContests(page, { startsInSec: 3600 });
  tweak?.(state as unknown as Record<string, Record<string, unknown>>);
  await page.goto(path);
}

test.describe('UI-05: home (S03)', () => {
  test('cards: next contest with Register, what I last practised, recent submissions, activity', async ({
    page,
  }) => {
    await open(page, '/home');
    await expect(
      page.getByRole('heading', { level: 1, name: 'Welcome back, riya_k' }),
    ).toBeVisible();
    const next = page.getByRole('region', { name: 'Next contest' });
    await expect(next).toContainText('CodeArena Warm-up #1');
    await expect(next).toContainText('Starts in 1d');
    await expect(next.getByRole('link', { name: 'Register' })).toHaveAttribute(
      'href',
      '/c/warm-up-1',
    );
    const cont = page.getByRole('list', { name: 'Recent problems' }).getByRole('listitem');
    await expect(cont.first()).toContainText('Two Numbers, One Total');
    await expect(cont.first()).toContainText('Solved');
    await expect(cont.nth(1)).toContainText('Not solved yet');
    await expect(
      page.getByRole('list', { name: 'Recent submissions' }).getByRole('listitem').first(),
    ).toContainText('WA');
    await expect(
      page.getByRole('img', { name: /Activity: 15 submissions in the last year/ }),
    ).toBeVisible();
    // No warm-up card for someone who has already submitted.
    await expect(page.getByRole('heading', { name: /warm-up problems/ })).toHaveCount(0);
  });

  test('registered shows "You are registered" and the lobby link; a running contest shows Open the contest', async ({
    page,
  }) => {
    await open(page, '/home', (s) => {
      (s.home!.nextContest as Record<string, unknown>).registered = true;
    });
    const next = page.getByRole('region', { name: 'Next contest' });
    await expect(next).toContainText('You are registered');
    await expect(next.getByRole('link', { name: 'Open the lobby' })).toBeVisible();
    await page.unroute('**/api/me/home');
    await page.route('**/api/me/home', (r) =>
      r.fulfill({
        json: {
          nextContest: {
            slug: 'warm-up-1',
            title: 'W',
            startsAt: new Date().toISOString(),
            endsAt: new Date(Date.now() + 3_600_000).toISOString(),
            state: 'running',
            registered: true,
          },
          continuePracticing: [],
          warmUps: [],
        },
      }),
    );
    await page.reload();
    await expect(page.getByRole('link', { name: 'Open the contest' })).toBeVisible();
    await expect(page.getByText('Running now')).toBeVisible();
  });

  test('a newcomer gets warm-ups and gentle empty states; no contest says so', async ({ page }) => {
    await open(page, '/home', (s) => {
      s.home!.nextContest = null as never;
      s.home!.continuePracticing = [];
      s.home!.warmUps = [
        { slug: 'sum-two-numbers', title: 'Two Numbers, One Total', difficulty: 800 },
        { slug: 'stair-climb', title: 'Stair Climb', difficulty: 900 },
      ];
    });
    await expect(
      page.getByRole('heading', { name: 'Start with these warm-up problems' }),
    ).toBeVisible();
    await expect(
      page
        .getByRole('list', { name: 'Warm-up problems' })
        .getByRole('link', { name: 'Stair Climb' }),
    ).toHaveAttribute('href', '/p/stair-climb');
    await expect(page.getByText('No contest is scheduled yet.')).toBeVisible();
    await expect(page.getByText('Nothing yet.')).toBeVisible();
  });

  test('a guest is asked to sign in', async ({ page }) => {
    await open(page, '/home', undefined, { signedIn: false });
    await expect(
      page.getByText('Sign in to see your contests, practice and activity.'),
    ).toBeVisible();
    await expect(page.getByRole('link', { name: 'Sign in' }).first()).toHaveAttribute(
      'href',
      /signin\?returnTo=%2Fhome/,
    );
  });

  test('the rail has Home and Profile that lead somewhere; /profile goes to my profile', async ({
    page,
  }) => {
    await open(page, '/home');
    await page.getByRole('link', { name: 'Profile' }).first().click();
    await expect(page).toHaveURL(/\/u\/riya_k$/);
    await expect(page.getByRole('heading', { level: 1, name: 'riya_k' })).toBeVisible();
  });
});

test.describe('UI-05: profile (S12)', () => {
  test('header with tier word and join date; heatmap; solved by difficulty and tag; history', async ({
    page,
  }) => {
    await open(page, '/u/riya_k');
    await expect(page.getByRole('heading', { level: 1, name: 'riya_k' })).toBeVisible();
    await expect(page.getByText('Specialist')).toBeVisible();
    await expect(page.getByText('Joined 1 September 2026')).toBeVisible();
    await expect(
      page.getByRole('img', {
        name: /Activity: 15 submissions in the last year, the most on .* \(9\)/,
      }),
    ).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Solved (7)' })).toBeVisible();
    const diff = page.getByRole('list', { name: 'By difficulty' });
    await expect(diff.getByRole('listitem').first()).toContainText('Under 1000');
    await expect(diff.getByRole('listitem').first()).toContainText('4');
    const tags = page.getByRole('list', { name: 'By tag (top 10)' });
    await expect(tags.getByRole('listitem').first()).toContainText('math');
    await expect(page.getByRole('img', { name: /Rating over 3 contests/ })).toBeVisible();
  });

  test('someone who has solved nothing, and an unknown handle', async ({ page }) => {
    await open(page, '/u/newbie', (s) => {
      s.profile!.solved = { total: 0, byDifficulty: [], byTag: [] };
      s.profile!.activity = { from: '2025-10-09', to: '2026-10-08', total: 0, days: [] };
    });
    await expect(page.getByText('No problems solved yet.')).toBeVisible();
    await expect(
      page.getByRole('img', { name: 'Activity: No submissions in the last year' }),
    ).toBeVisible();
    await page.goto('/u/ghost');
    await expect(page.getByText('No such user.')).toBeVisible();
  });
});

for (const theme of ['dark', 'light'] as const) {
  for (const size of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`UI-05 a11y: home and profile, ${theme}, ${size.width}px, no horizontal scroll`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({
        viewport: size,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      await stubApi(page);
      await stubContests(page, { startsInSec: 3600 });
      const check = async (what: string) => {
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
          `${what} overflows`,
        ).toBeLessThanOrEqual(0);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .analyze();
        expect(
          results.violations
            .filter((v) => v.impact === 'serious' || v.impact === 'critical')
            .map((v) => `${what} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
        ).toEqual([]);
      };
      await page.goto('/home');
      await expect(page.getByRole('region', { name: 'Next contest' })).toBeVisible();
      await check('home');
      await page.goto('/u/riya_k');
      await expect(page.getByRole('heading', { name: /Solved/ })).toBeVisible();
      await check('profile');
      await ctx.close();
    });
  }
}
