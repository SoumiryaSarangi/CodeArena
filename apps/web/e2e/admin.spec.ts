import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';
import { stubAdmin } from './stub-admin';
import { stubApi } from './stub-api';

const PACKAGE = resolve(__dirname, '../../../problems/hop-distances');
const editorReady = (page: Page) =>
  page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 60_000 });

async function setup(page: Page, role: 'user' | 'setter' | 'admin' = 'setter', admin = {}) {
  await stubApi(page, { role });
  return stubAdmin(page, admin);
}

test.describe('UI-04: who can see the setter screens (FR-AUTH-09)', () => {
  test('a guest is asked to sign in', async ({ page }) => {
    await stubApi(page, { signedIn: false });
    await page.goto('/admin/problems');
    await expect(page.getByText('Sign in to manage problems.')).toBeVisible();
    await expect(page.locator('#main').getByRole('link', { name: 'Sign in' })).toBeVisible();
  });

  test('a regular user gets no Admin entry and a plain "not allowed"', async ({ page }) => {
    await setup(page, 'user');
    await page.goto('/practice');
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByRole('link', { name: 'Admin' })).toHaveCount(0);
    await page.goto('/admin/problems');
    await expect(page.getByRole('heading', { name: 'Not allowed' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Problems' })).toHaveCount(0);
  });

  test('a setter sees the Admin entry and the problem list', async ({ page }) => {
    await setup(page, 'setter');
    await page.goto('/practice');
    await page.getByRole('link', { name: 'Admin' }).click();
    await expect(page).toHaveURL(/\/admin\/problems$/);
    await expect(page.getByRole('heading', { name: 'Problems', level: 1 })).toBeVisible();
    const row = page.getByRole('row', { name: /hop-distances/ });
    await expect(row).toContainText('Hop Distances');
    await expect(row).toContainText('Not validated');
    await expect(row).toContainText('v1');
  });
});

test.describe('UI-04: upload a package folder (FR-PROB-01)', () => {
  test('sends only the package files, named by their paths, with the folder name as slug', async ({
    page,
  }) => {
    const admin = await setup(page);
    await page.goto('/admin/problems');
    await page.getByTestId('folder-input').setInputFiles(PACKAGE);
    const summary = page.getByTestId('upload-summary');
    await expect(summary).toContainText('10 tests');
    await expect(summary).toContainText('other files will not be sent');
    await expect(page.getByLabel('Problem slug')).toHaveValue('hop-distances');
    await page.getByRole('button', { name: 'Upload package' }).click();
    await expect(
      page.getByRole('status').filter({ hasText: 'created, version 1 with 10 tests' }),
    ).toBeVisible();
    expect(admin.uploads).toHaveLength(1);
    const { parts, slug } = admin.uploads[0]!;
    expect(slug).toBe('hop-distances');
    for (const p of [
      'problem.yaml',
      'statement.md',
      'editorial.md',
      'validator.cpp',
      'tests/01.in',
      'tests/10.ans',
      'solutions/main.cpp',
      'solutions/alt.py',
    ]) {
      expect(parts).toContain(p);
    }
    expect(parts.some((p) => p.startsWith('generators/'))).toBe(false);
  });

  test("the server's itemised errors are listed with their file paths", async ({ page }) => {
    await setup(page, 'setter', { uploadError: true });
    await page.goto('/admin/problems');
    await page.getByTestId('folder-input').setInputFiles(PACKAGE);
    await page.getByRole('button', { name: 'Upload package' }).click();
    const alert = page.locator('#main').getByRole('alert');
    await expect(alert).toContainText('The package has 2 problem(s)');
    await expect(alert).toContainText('validator.cpp');
    await expect(alert).toContainText('validator.cpp is missing');
    await expect(alert).toContainText('tests/03.in');
  });
});

test.describe('UI-04: one problem', () => {
  test('overview shows the metadata and versions; only an admin can change visibility', async ({
    page,
  }) => {
    const admin = await setup(page, 'setter');
    await page.goto('/admin/problems/hop-distances');
    await expect(page.getByRole('heading', { level: 1, name: 'Hop Distances' })).toBeVisible();
    await expect(page.getByText('500 ms · 256 MB · 1024 KB output')).toBeVisible();
    await expect(page.getByRole('row', { name: /v1/ })).toBeVisible();
    await expect(page.getByRole('combobox', { name: 'Visibility' })).toHaveCount(0);
    expect(admin.visibility).toEqual([]);
  });

  test('an admin changes visibility and sees it', async ({ page }) => {
    const admin = await setup(page, 'admin');
    await page.goto('/admin/problems/hop-distances');
    await page.getByRole('combobox', { name: 'Visibility' }).selectOption('public');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(page.getByText('Visibility is now public.')).toBeVisible();
    expect(admin.visibility).toEqual(['public']);
  });

  test('the statement has a live preview and Save makes a new version', async ({ page }) => {
    const admin = await setup(page);
    await page.goto('/admin/problems/hop-distances');
    await page.getByRole('tab', { name: 'Statement' }).click();
    await editorReady(page);
    const preview = page.getByRole('region', { name: 'Statement preview' });
    await expect(preview.getByRole('heading', { name: 'Hop Distances' })).toBeVisible();
    await expect(preview.locator('.katex').first()).toBeVisible();
    const save = page.getByRole('button', { name: 'Save as a new version' });
    await expect(save).toBeDisabled();

    await page.locator('.monaco-editor .view-lines').first().click();
    await page.keyboard.press('Control+A');
    await page.keyboard.type(
      '# Remixed title\n\nA paragraph.\n\n## Input\n\nx\n\n## Output\n\ny\n\n## Notes\n\nz\n',
    );
    await expect(preview.getByRole('heading', { name: 'Remixed title' })).toBeVisible();
    // The text has "g" and a later "p" typed within a second: that must not read as the "g p"
    // shortcut (go to Practice) while typing in the editor.
    await expect(page).toHaveURL(/\/admin\/problems\/hop-distances$/);
    await expect(page.getByText('Unsaved changes')).toBeVisible();
    await save.click();
    await expect(page.getByText('Saved as version 2.')).toBeVisible();
    expect(admin.saves).toHaveLength(1);
    expect(admin.saves[0]!.statementMd).toContain('# Remixed title');
    expect(admin.saves[0]!.editorialMd).toBe('Breadth-first search.');
    await expect(page.getByText('v2').first()).toBeVisible();
  });

  test('tests are listed with sample flags and download as files', async ({ page }) => {
    const admin = await setup(page);
    await page.goto('/admin/problems/hop-distances');
    await page.getByRole('tab', { name: 'Tests' }).click();
    await expect(page.getByRole('cell', { name: 'sample', exact: true })).toHaveCount(2);
    await expect(page.getByText('4 tests. Only you and admins can download them.')).toBeVisible();
    const one = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download test 01 input' }).click();
    expect((await one).suggestedFilename()).toBe('01.in');
    const all = page.waitForEvent('download');
    await page.getByRole('button', { name: 'Download all (tests.tar)' }).click();
    expect((await all).suggestedFilename()).toBe('tests.tar');
    expect(admin.downloads).toEqual(['01.in', 'tests.tar']);
  });

  test('Validate runs the solutions and shows expected against actual, with what differs', async ({
    page,
  }) => {
    const admin = await setup(page, 'setter', { failValidatorTest: true });
    await page.goto('/admin/problems/hop-distances');
    await page.getByRole('tab', { name: 'Solutions & Validation' }).click();
    await expect(page.getByText('Not run yet.')).toBeVisible();
    await expect(page.getByRole('row', { name: /wa-dfs-depth\.cpp/ })).toContainText('WA');

    await page.getByRole('button', { name: 'Validate' }).click();
    await expect(page.getByText(/Judging 5 jobs/)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Validate' })).toBeDisabled();
    await expect(page.getByText('2 of 5 do not match what the package declares.')).toBeVisible({
      timeout: 15_000,
    });
    expect(admin.validates).toBe(1);

    await expect(page.getByRole('row', { name: /main\.cpp/ })).toContainText('as expected');
    const wa = page.getByRole('row', { name: /wa-dfs-depth\.cpp/ });
    await expect(wa).toContainText('differs');
    const diff = page.getByRole('region', { name: 'What differs' });
    await expect(diff).toContainText('wa-dfs-depth.cpp: expected WA, got AC.');
    await expect(diff).toContainText('test 4: WA — n = 0 violates the range [1, 50000]');
    await expect(page.getByText('Validation failed').first()).toBeVisible();
  });

  test('a version imported before validators were stored explains what to do', async ({ page }) => {
    await setup(page, 'setter', { validatorStored: false });
    await page.goto('/admin/problems/hop-distances');
    await page.getByRole('tab', { name: 'Solutions & Validation' }).click();
    await expect(page.getByRole('button', { name: 'Validate' })).toBeDisabled();
    await expect(page.getByText(/Upload the package again/)).toBeVisible();
  });

  test('keyboard: the tabs move with the arrow keys and the folder button is reachable', async ({
    page,
  }) => {
    await setup(page);
    await page.goto('/admin/problems/hop-distances');
    await page.getByRole('tab', { name: 'Overview' }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('tab', { name: 'Statement' })).toBeFocused();
    await page.getByRole('tab', { name: 'Overview' }).click();
    await page.getByRole('button', { name: 'Choose folder' }).focus();
    await expect(page.getByRole('button', { name: 'Choose folder' })).toBeFocused();
  });
});

for (const theme of ['dark', 'light'] as const) {
  for (const size of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`UI-04 a11y: list and every tab, ${theme}, ${size.width}px, no page-level horizontal scroll`, async ({
      browser,
    }) => {
      const ctx = await browser.newContext({
        viewport: size,
        colorScheme: theme,
        reducedMotion: 'reduce',
      });
      const page = await ctx.newPage();
      await stubApi(page, { role: 'admin' });
      await stubAdmin(page, { failValidatorTest: true });
      const check = async (what: string) => {
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
          `${what} overflows the page`,
        ).toBeLessThanOrEqual(0);
        const results = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .exclude('.monaco-editor') // third-party widget
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
      await page.goto('/admin/problems');
      await expect(page.getByRole('row', { name: /hop-distances/ })).toBeVisible();
      await check('list');
      await page.goto('/admin/problems/hop-distances');
      await expect(page.getByRole('heading', { level: 1, name: 'Hop Distances' })).toBeVisible();
      await check('overview');
      await page.getByRole('tab', { name: 'Statement' }).click();
      await editorReady(page);
      await check('statement');
      await page.getByRole('tab', { name: 'Tests' }).click();
      await expect(page.getByRole('cell', { name: 'sample', exact: true }).first()).toBeVisible();
      await check('tests');
      await page.getByRole('tab', { name: 'Solutions & Validation' }).click();
      await page.getByRole('button', { name: 'Validate' }).click();
      await expect(page.getByText(/do not match/)).toBeVisible({ timeout: 15_000 });
      await check('validation');
      await page.getByRole('tab', { name: 'Hints' }).click();
      await editorReady(page);
      await check('hints');
      await ctx.close();
    });
  }
}
