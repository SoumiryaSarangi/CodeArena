import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page, type Route } from '@playwright/test';

/**
 * UI-01 against a stubbed API, so it runs anywhere (the API's own tests cover the data). The stub
 * applies the same filter rules as the real endpoint.
 */
const ALL = [
  ['peak-reading', 'Peak Reading', 800, ['implementation', 'arrays'], 91.2],
  ['sum-two-numbers', 'Two Numbers, One Total', 800, ['implementation', 'math'], 74.5],
  ['maze-runner', 'Maze Runner', 1200, ['bfs', 'graphs', 'grids'], 40.1],
  ['hop-distances', 'Hop Distances', 1300, ['bfs', 'graphs'], null],
  ['spell-fixer', 'Spell Fixer', 1600, ['dp', 'strings', 'strings2', 'x', 'y'], 12.0],
].map(([slug, title, difficulty, tags, acceptance]) => ({
  slug: slug as string,
  title: title as string,
  difficulty: difficulty as number,
  tags: tags as string[],
  practicePoints: (difficulty as number) / 100,
  acceptance: acceptance as number | null,
  status: null as string | null,
}));

async function stub(page: Page, opts: { failing?: boolean; signedIn?: boolean } = {}) {
  const state = { failing: opts.failing ?? false };
  const requests: string[] = [];
  await page.route('**/api/problems/tags', (r: Route) =>
    r.fulfill({
      json: {
        items: [
          { tag: 'bfs', count: 2 },
          { tag: 'dp', count: 1 },
          { tag: 'graphs', count: 2 },
        ],
      },
    }),
  );
  await page.route('**/api/problems?**', (r: Route) => {
    const url = new URL(r.request().url());
    requests.push(url.search);
    if (state.failing) {
      return r.fulfill({
        status: 500,
        contentType: 'application/problem+json',
        json: {
          code: 'internal',
          title: 'Internal error',
          instance: 'req-123',
          status: 500,
          type: 'x',
        },
      });
    }
    const g = (k: string) => url.searchParams.get(k);
    if (g('status') && !opts.signedIn)
      return r.fulfill({
        status: 401,
        contentType: 'application/problem+json',
        json: { code: 'unauthorized', title: 'Unauthorized', status: 401, type: 'x' },
      });
    const tags = (g('tags') ?? '').split(',').filter(Boolean);
    const items = ALL.filter(
      (p) =>
        (!g('q') || p.title.toLowerCase().includes(g('q')!.toLowerCase())) &&
        (!g('minDiff') || p.difficulty >= Number(g('minDiff'))) &&
        (!g('maxDiff') || p.difficulty <= Number(g('maxDiff'))) &&
        tags.every((t) => p.tags.includes(t)),
    ).map((p) =>
      opts.signedIn ? { ...p, status: p.slug === 'peak-reading' ? 'solved' : 'new' } : p,
    );
    return r.fulfill({ json: { items, nextCursor: null } });
  });
  return Object.assign(requests, { state });
}

const rows = (page: Page) => page.locator('tbody tr');

test('UI-01: lists problems with title, difficulty word + number, tags (max 3 + n), acceptance', async ({
  page,
}) => {
  await stub(page);
  await page.goto('/practice');
  await expect(rows(page)).toHaveCount(5);
  const first = rows(page).first();
  await expect(first).toContainText('Peak Reading');
  await expect(first).toContainText('Easy 800');
  await expect(first).toContainText('91.2%');
  await expect(rows(page).nth(3)).toContainText('—'); // no submissions yet: no percentage
  const spell = rows(page).nth(4);
  await expect(spell).toContainText('+2');
  await expect(spell.getByText('x', { exact: true })).toHaveCount(0); // only 3 tags shown
  await expect(first.getByRole('img', { name: 'Sign in to track your progress' })).toBeVisible();
});

test('UI-01: filters are mirrored in the URL and survive a reload', async ({ page }) => {
  const requests = await stub(page);
  await page.goto('/practice');
  await expect(rows(page)).toHaveCount(5);

  await page.getByLabel('Search').fill('maze');
  await expect(page).toHaveURL(/q=maze/);
  await expect(rows(page)).toHaveCount(1);
  await page.getByLabel('Search').fill('');
  await expect(rows(page)).toHaveCount(5);

  await page.getByLabel('Min difficulty').selectOption('1200');
  await page.getByLabel('Max difficulty').selectOption('1300');
  await expect(page).toHaveURL(/minDiff=1200/);
  await expect(page).toHaveURL(/maxDiff=1300/);
  await expect(rows(page)).toHaveCount(2);

  await page.getByRole('button', { name: /Any tag/ }).click();
  await page.getByLabel('graphs').check();
  await page.getByLabel('bfs').check();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: '2 selected' })).toBeFocused();
  await expect(page).toHaveURL(/tags=graphs%2Cbfs|tags=graphs,bfs/);
  await expect(rows(page)).toHaveCount(2);

  await page.reload();
  await expect(page.getByLabel('Min difficulty')).toHaveValue('1200');
  await expect(page.getByRole('button', { name: '2 selected' })).toBeVisible();
  await expect(rows(page)).toHaveCount(2);
  expect(requests.at(-1)).toContain('tags=graphs%2Cbfs');
});

test('UI-01: nothing matches → "No problems match" with Clear filters that resets everything', async ({
  page,
}) => {
  await stub(page);
  await page.goto('/practice?q=zzz&minDiff=1200');
  await expect(page.getByText('No problems match.')).toBeVisible();
  await page.getByRole('main').getByRole('button', { name: 'Clear filters' }).first().click();
  await expect(page).toHaveURL(/\/practice$/);
  await expect(rows(page)).toHaveCount(5);
  await expect(page.getByLabel('Search')).toHaveValue('');
});

test('UI-01: a minimum above the maximum is explained instead of showing an empty table', async ({
  page,
}) => {
  await stub(page);
  await page.goto('/practice?minDiff=1500&maxDiff=1000');
  await expect(page.getByRole('alert').filter({ hasText: 'minimum difficulty' })).toBeVisible();
});

test('UI-01: keyboard: "/" focuses search, arrows move between rows, Enter opens the problem', async ({
  page,
}) => {
  await stub(page);
  await page.goto('/practice');
  await expect(rows(page)).toHaveCount(5);
  await page.keyboard.press('/');
  await expect(page.getByLabel('Search')).toBeFocused();
  await page.keyboard.type('/x'); // typing "/" inside the box is just text
  await page.getByLabel('Search').fill('');
  await expect(rows(page)).toHaveCount(5);

  await rows(page).first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(rows(page).nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(rows(page).first()).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/\/p\/peak-reading$/);
});

test('UI-01: a failed load shows what happened with the request id, and Try again recovers', async ({
  page,
}) => {
  const api = await stub(page, { failing: true });
  await page.goto('/practice');
  await expect(page.getByRole('alert').filter({ hasText: 'req-123' })).toBeVisible();
  api.state.failing = false;
  await page.getByRole('button', { name: 'Try again' }).click();
  await expect(rows(page)).toHaveCount(5);
});

test('UI-01: the status filter asks guests to sign in; signed-in users see solved with a text label', async ({
  page,
}) => {
  await stub(page);
  await page.goto('/practice?status=solved');
  await expect(page.getByText('Sign in to filter by your progress.')).toBeVisible();
  await page.getByRole('button', { name: 'Show all problems' }).click();
  await expect(rows(page)).toHaveCount(5);

  const signed = await page.context().newPage();
  await stub(signed, { signedIn: true });
  await signed.goto('/practice');
  await expect(signed.getByRole('img', { name: 'Solved' })).toHaveCount(1);
  await expect(signed.getByRole('img', { name: 'Not attempted' })).toHaveCount(4);
});

for (const [width, height] of [
  [1280, 900],
  [390, 844],
] as const) {
  for (const theme of ['dark', 'light'] as const) {
    test(`UI-01: /practice at ${width}px in ${theme} is accessible and has no page-level horizontal scroll`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({
        viewport: { width, height },
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      await stub(page);
      await page.goto('/practice');
      await expect(rows(page)).toHaveCount(5);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
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
