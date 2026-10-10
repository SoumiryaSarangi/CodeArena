import { expect, test, type Page } from '@playwright/test';
import { stubApi } from './stub-api';
import { stubContests } from './stub-contests';

const editorReady = (page: Page) =>
  page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 60_000 });
const editorText = async (page: Page) =>
  (await page.locator('.monaco-editor .view-lines').first().innerText()).replace(/\u00a0/g, ' ');
const widget = (page: Page) => page.locator('.suggest-widget.visible');
const rows = (page: Page) => widget(page).locator('.monaco-list-row');

/** Replace the editor's text with what a person types, one key at a time (suggestions open on typing). */
async function typeCode(page: Page, text: string) {
  // A suggestion list left open by the previous call can sit over the middle of the editor, where the click lands
  // (UI-17: the status strip makes the editor shorter, so it does now); closing it first is what a person would do.
  await page.keyboard.press('Escape');
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+A');
  await page.keyboard.press('Delete');
  await page.keyboard.type(text, { delay: 40 });
}

test.describe('ED-01: code suggestions in the practice editor', () => {
  test('FR-EDIT-01: typing "whi" offers while, and Tab inserts the snippet with the cursor in the condition', async ({
    page,
  }) => {
    await stubApi(page);
    await page.goto('/p/sum-two-numbers');
    await editorReady(page);
    await typeCode(page, 'whi');
    await expect(widget(page)).toBeVisible();
    await expect(rows(page).first()).toContainText('while');
    await page.keyboard.press('Tab');
    await expect.poll(() => editorText(page)).toContain('while (condition) {');
    // the first tab stop is selected: typing replaces the placeholder
    await page.keyboard.type('x < 3');
    await expect.poll(() => editorText(page)).toContain('while (x < 3) {');
  });

  test('FR-EDIT-01: for offers the loop snippet and library names are offered too (C++)', async ({
    page,
  }) => {
    await stubApi(page);
    await page.goto('/p/sum-two-numbers');
    await editorReady(page);
    await typeCode(page, 'for');
    await expect(widget(page)).toBeVisible();
    await expect(widget(page)).toContainText('for loop');
    await typeCode(page, 'priority_q');
    await expect(rows(page).first()).toContainText('priority_queue');
  });

  test('FR-EDIT-01: Python and Java get their own suggestions', async ({ page }) => {
    await stubApi(page);
    await page.goto('/p/sum-two-numbers');
    await editorReady(page);
    await page.getByLabel('Language').selectOption('python3');
    await expect(page.getByLabel('Code editor, Python 3')).toBeAttached();
    await typeCode(page, 'enumer');
    await expect(rows(page).first()).toContainText('enumerate');
    await page.getByLabel('Language').selectOption('java21');
    await expect(page.getByLabel('Code editor, Java 21')).toBeAttached();
    await typeCode(page, 'ArrayL');
    await expect(rows(page).first()).toContainText('ArrayList');
  });

  test('FR-EDIT-01: nothing is suggested inside a comment', async ({ page }) => {
    await stubApi(page);
    await page.goto('/p/sum-two-numbers');
    await editorReady(page);
    await typeCode(page, '// whi');
    await page.waitForTimeout(800);
    await expect(widget(page)).toHaveCount(0);
  });
});

test.describe('ED-01: a contest can switch suggestions off', () => {
  const RUNNING = { startsInSec: -30 * 60, durationMin: 180, registered: true };

  test('FR-EDIT-02: with the rule on (the default) a contest editor suggests as in practice', async ({
    page,
  }) => {
    await stubApi(page);
    await stubContests(page, RUNNING);
    await page.goto('/c/warm-up-1/A');
    await editorReady(page);
    await typeCode(page, 'whi');
    await expect(widget(page)).toBeVisible();
  });

  test('FR-EDIT-02: with the rule off nothing opens while typing and the manual shortcut does nothing', async ({
    page,
  }) => {
    await stubApi(page);
    await stubContests(page, { ...RUNNING, suggestions: false });
    await page.goto('/c/warm-up-1/A');
    await editorReady(page);
    await typeCode(page, 'whi');
    await page.waitForTimeout(800);
    await expect(widget(page)).toHaveCount(0);
    await page.keyboard.press('Control+Space');
    await page.waitForTimeout(500);
    await expect(widget(page)).toHaveCount(0);
    // the editor itself still works
    await expect.poll(() => editorText(page)).toContain('whi');
    await page.keyboard.press('Enter');
    await page.keyboard.type('ok');
    await expect.poll(() => editorText(page)).toContain('ok');
  });

  test('FR-EDIT-02: practice is not affected by a contest rule', async ({ page }) => {
    await stubApi(page);
    await stubContests(page, { ...RUNNING, suggestions: false });
    await page.goto('/p/sum-two-numbers');
    await editorReady(page);
    await typeCode(page, 'whi');
    await expect(widget(page)).toBeVisible();
  });
});
