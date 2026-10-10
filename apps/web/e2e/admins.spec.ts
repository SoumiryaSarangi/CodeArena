import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { stubAdmin } from './stub-admin';
import { stubApi } from './stub-api';

const OWNER = 'owner@example.test';

/** The owner's list, kept in memory like the API keeps it in the database. */
async function grants(
  page: Page,
  initial: { email: string; signedUp: boolean }[] = [],
  base: 'admins' | 'setters' = 'admins',
) {
  const list = [...initial];
  const sent: string[] = [];
  await page.route(`**/api/admin/${base}`, async (r) => {
    if (r.request().method() === 'POST') {
      const { email } = r.request().postDataJSON() as { email: string };
      sent.push(email);
      if (list.some((g) => g.email === email))
        return r.fulfill({
          status: 409,
          contentType: 'application/problem+json',
          body: JSON.stringify({
            code: 'conflict',
            title: 'Changed elsewhere',
            status: 409,
            type: 'x',
            detail: 'That address is already listed.',
          }),
        });
      list.push({ email, signedUp: false });
      return r.fulfill({ status: 204 });
    }
    return r.fulfill({
      contentType: 'application/json',
      body: JSON.stringify({
        owner: OWNER,
        max: 50,
        grants: list.map((g) => ({
          ...g,
          grantedBy: OWNER,
          createdAt: '2026-10-10T10:00:00.000Z',
        })),
      }),
    });
  });
  await page.route(`**/api/admin/${base}/*`, async (r) => {
    const email = decodeURIComponent(new URL(r.request().url()).pathname.split('/').at(-1)!);
    list.splice(
      list.findIndex((g) => g.email === email),
      1,
    );
    return r.fulfill({ status: 204 });
  });
  return { list, sent };
}

test('FR-AUTH-13: the owner sees an Admins tab; another admin does not', async ({ page }) => {
  await stubApi(page, { role: 'admin', owner: true });
  await stubAdmin(page);
  await page.goto('/admin/problems');
  await expect(page.getByRole('link', { name: 'Admins' })).toBeVisible();
});

test('FR-AUTH-13: an ordinary admin has no tab and the page says only the owner can use it', async ({
  page,
}) => {
  await stubApi(page, { role: 'admin' });
  await stubAdmin(page);
  await page.goto('/admin/problems');
  await expect(page.getByRole('link', { name: 'Admins' })).toHaveCount(0);
  await page.goto('/admin/admins');
  await expect(
    page.getByText('Only the owner of this site can choose who is an admin or a setter.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add admin' })).toHaveCount(0);
});

test('FR-AUTH-12: the owner adds an address, sees it waiting, and removes it after confirming', async ({
  page,
}) => {
  await stubApi(page, { role: 'admin', owner: true });
  await stubAdmin(page);
  await grants(page, [], 'setters');
  const { sent } = await grants(page, [{ email: 'asha@gmail.com', signedUp: true }]);
  await page.goto('/admin/admins');
  await expect(page.getByRole('heading', { level: 1, name: 'Admins' })).toBeVisible();
  await expect(page.getByText(OWNER)).toBeVisible();
  await expect(page.getByText('Admin now')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add admin' })).toBeDisabled();
  await page.getByLabel('Email address').fill('Ben@Gmail.com');
  await page.getByRole('button', { name: 'Add admin' }).click();
  await expect(page.getByText('Waiting for their first sign-in')).toBeVisible();
  expect(sent).toEqual(['Ben@Gmail.com']); // the server lower-cases it
  // a duplicate shows the server's words
  await page.getByLabel('Email address').fill('Ben@Gmail.com');
  await page.getByRole('button', { name: 'Add admin' }).click();
  await expect(page.getByText('That address is already listed.')).toBeVisible();
  // removing asks first
  await page.getByRole('button', { name: 'Remove asha@gmail.com' }).click();
  await expect(page.getByRole('dialog', { name: 'Remove this admin?' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep' }).click();
  await expect(page.getByText('asha@gmail.com')).toBeVisible();
  await page.getByRole('button', { name: 'Remove asha@gmail.com' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('asha@gmail.com')).toHaveCount(0);
});

for (const theme of ['dark', 'light'] as const)
  for (const width of [1280, 390])
    test(`FR-AUTH-13: the Admins page at ${width}px in ${theme} is accessible with no horizontal scroll`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({
        viewport: { width, height: 800 },
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      await stubApi(page, { role: 'admin', owner: true });
      await stubAdmin(page);
      await grants(
        page,
        [
          {
            email: 'long_setter_address_that_keeps_going_2026@example-campus-cohort.test',
            signedUp: false,
          },
        ],
        'setters',
      );
      await grants(page, [
        {
          email: 'a_very_long_address_that_keeps_going_and_going_2026@example-campus-cohort.test',
          signedUp: false,
        },
        { email: 'asha@gmail.com', signedUp: true },
      ]);
      await page.goto('/admin/admins');
      await expect(page.getByRole('heading', { level: 1, name: 'Admins' })).toBeVisible();
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
      ).toBeLessThanOrEqual(0);
      const results = await new AxeBuilder({ page })
        .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
        .analyze();
      expect(
        results.violations
          .filter((v) => v.impact === 'serious' || v.impact === 'critical')
          .map((v) => `${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`),
      ).toEqual([]);
      await ctx.close();
    });

test('FR-AUTH-15: the owner lists a setter, sees it waiting, and removes it after confirming; the admin list is untouched', async ({
  page,
}) => {
  await stubApi(page, { role: 'admin', owner: true });
  await stubAdmin(page);
  await grants(page, [{ email: 'asha@gmail.com', signedUp: true }]);
  const { sent } = await grants(page, [{ email: 'tara@gmail.com', signedUp: true }], 'setters');
  await page.goto('/admin/admins');
  await expect(page.getByRole('heading', { level: 1, name: 'Admins' })).toBeVisible();
  await expect(page.getByRole('heading', { level: 2, name: 'Setters' })).toBeVisible();
  await expect(page.getByText('A setter writes problems')).toBeVisible();
  await expect(page.getByText('Setter now')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Add setter' })).toBeDisabled();
  await page.getByLabel("Setter's address").fill('Ravi@Gmail.com');
  await page.getByRole('button', { name: 'Add setter' }).click();
  await expect(page.getByText('Waiting for their first sign-in')).toBeVisible();
  expect(sent).toEqual(['Ravi@Gmail.com']);
  await page.getByLabel("Setter's address").fill('Ravi@Gmail.com');
  await page.getByRole('button', { name: 'Add setter' }).click();
  await expect(page.getByText('That address is already listed.')).toBeVisible();
  await page.getByRole('button', { name: 'Remove setter tara@gmail.com' }).click();
  await expect(page.getByRole('dialog', { name: 'Remove this setter?' })).toBeVisible();
  await expect(page.getByRole('dialog')).toContainText('an admin stays an admin');
  await page.getByRole('button', { name: 'Keep' }).click();
  await expect(page.getByText('tara@gmail.com')).toBeVisible();
  await page.getByRole('button', { name: 'Remove setter tara@gmail.com' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Remove' }).click();
  await expect(page.getByText('tara@gmail.com')).toHaveCount(0);
  // the admin list is still there and unchanged
  await expect(page.getByText('asha@gmail.com')).toBeVisible();
});
