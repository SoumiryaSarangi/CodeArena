import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Page } from '@playwright/test';
import { emit, sseUrls, stubApi } from './stub-api';
import { stubAdmin } from './stub-admin';
import { stubContests } from './stub-contests';

const RUNNING = { startsInSec: -30 * 60, durationMin: 180, registered: true };
const ID = '11111111-1111-4111-8111-111111111111';

const streamOpen = (page: Page, part: string) =>
  expect
    .poll(async () => (await sseUrls(page)).some((u) => decodeURIComponent(u).includes(part)))
    .toBe(true);

async function arena(page: Page, opts: Parameters<typeof stubContests>[1] = RUNNING) {
  await stubApi(page);
  const st = await stubContests(page, opts);
  await page.goto('/c/warm-up-1/A');
  await expect(page.getByRole('heading', { level: 1, name: 'A. Chai Bill' })).toBeVisible();
  await streamOpen(page, 'contest:cid-1:clar');
  return st;
}
const drawerButton = (page: Page) => page.getByRole('button', { name: /^Clarifications/ });
const item = (id: string, over: object = {}) => ({
  id,
  problemLabel: null,
  question: 'Question?',
  answer: null,
  isPublic: false,
  mine: false,
  createdAt: '2026-10-10T13:30:00.000Z',
  answeredAt: null,
  ...over,
});

test.describe('C-05: clarifications in the arena (US-4.6)', () => {
  test('the drawer lists public answers and my questions, and hides other people’s open ones', async ({
    page,
  }) => {
    await arena(page);
    await drawerButton(page).click();
    const drawer = page.getByRole('dialog', { name: 'Clarifications' });
    await expect(drawer).toContainText('Can we leave the room?');
    await expect(drawer).toContainText('Yes, quietly.');
    await expect(drawer).toContainText('answered for everyone');
    await expect(drawer).not.toContainText('Is the grid always square?');
  });

  test('ask about the current problem: the form defaults to it, and the question waits for an answer', async ({
    page,
  }) => {
    const st = await arena(page);
    await drawerButton(page).click();
    const drawer = page.getByRole('dialog', { name: 'Clarifications' });
    await expect(drawer.getByLabel('About')).toHaveValue('A');
    await drawer.getByRole('textbox', { name: 'Question' }).fill('Is n at least 1?');
    await drawer.getByRole('button', { name: 'Send' }).click();
    await expect
      .poll(() => st.asked)
      .toEqual([{ problemLabel: 'A', question: 'Is n at least 1?' }]);
    await expect(drawer).toContainText('You asked · Problem A');
    await expect(drawer).toContainText('Waiting for an answer…');
    await expect(drawer.getByRole('textbox', { name: 'Question' })).toHaveValue('');
  });

  test('a general question has no problem label', async ({ page }) => {
    const st = await arena(page);
    await drawerButton(page).click();
    const drawer = page.getByRole('dialog', { name: 'Clarifications' });
    await drawer.getByLabel('About').selectOption('');
    await drawer.getByRole('textbox', { name: 'Question' }).fill('Is there a break?');
    await drawer.getByRole('button', { name: 'Send' }).click();
    await expect
      .poll(() => st.asked)
      .toEqual([{ problemLabel: null, question: 'Is there a break?' }]);
  });

  test('Send waits for some text', async ({ page }) => {
    await arena(page);
    await drawerButton(page).click();
    await expect(page.getByRole('dialog').getByRole('button', { name: 'Send' })).toBeDisabled();
  });

  test('FR-CONT-04: a public answer pops a toast and counts as unread until the drawer opens', async ({
    page,
  }) => {
    await arena(page);
    await emit(
      page,
      'clar',
      'clar.answer',
      '5-0',
      {
        contestId: 'cid-1',
        item: item('q3', {
          question: 'Is B hard?',
          answer: 'It is fair.',
          isPublic: true,
          answeredAt: '2026-10-10T13:31:00.000Z',
        }),
      },
      'contest:cid-1:clar',
    );
    await expect(page.getByText('New clarification')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Clarifications, 1 new' })).toBeVisible();
    await drawerButton(page).click();
    const drawer = page.getByRole('dialog', { name: 'Clarifications' });
    await expect(drawer).toContainText('It is fair.');
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Clarifications', exact: true })).toBeVisible(); // no badge left
  });

  test('a private answer to my question arrives on my own topic', async ({ page }) => {
    const st = await arena(page);
    await streamOpen(page, 'contest:cid-1:u:u1');
    await drawerButton(page).click();
    const drawer = page.getByRole('dialog', { name: 'Clarifications' });
    await drawer.getByRole('textbox', { name: 'Question' }).fill('Private one');
    await drawer.getByRole('button', { name: 'Send' }).click();
    await expect(drawer).toContainText('Waiting for an answer…');
    const mine = st.clarifications.at(-1)!;
    await page.keyboard.press('Escape');
    await emit(
      page,
      'clar',
      'clar.answer',
      '5-1',
      {
        contestId: 'cid-1',
        item: item(mine.id, {
          question: 'Private one',
          answer: 'Just for you.',
          mine: true,
          answeredAt: '2026-10-10T13:40:00.000Z',
        }),
      },
      'contest:cid-1:u:u1',
    );
    await expect(page.getByText('Your question was answered')).toBeVisible();
    await drawerButton(page).click();
    await expect(page.getByRole('dialog')).toContainText('Just for you.');
    await expect(page.getByRole('dialog')).toContainText('answered privately');
  });

  test('announcements pop a toast and are listed first in the drawer', async ({ page }) => {
    await arena(page);
    await emit(
      page,
      'clar',
      'announce.new',
      '5-2',
      {
        contestId: 'cid-1',
        item: { id: 'n1', body: 'Lunch is at one.', createdAt: '2026-10-10T13:35:00.000Z' },
      },
      'contest:cid-1:clar',
    );
    await expect(page.getByText('Announcement', { exact: true })).toBeVisible();
    await drawerButton(page).click();
    const notes = page.getByRole('region', { name: 'Announcements' });
    await expect(notes).toContainText('Lunch is at one.');
  });

  test('after the end the form is replaced by a note', async ({ page }) => {
    await arena(page, { startsInSec: -300 * 60, durationMin: 120, registered: true });
    await drawerButton(page).click();
    await expect(page.getByRole('dialog')).toContainText(
      'Questions can be asked while the contest runs.',
    );
    await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Question' })).toHaveCount(
      0,
    );
  });
});

async function ops(page: Page, role: 'admin' | 'setter' = 'admin') {
  await stubApi(page, { role });
  await stubAdmin(page);
  const st = await stubContests(page, RUNNING);
  await page.goto(`/admin/contests/${ID}/ops`);
  return st;
}

test.describe('C-05: admin inbox and announcements (S16)', () => {
  test('a setter may not use the console', async ({ page }) => {
    await ops(page, 'setter');
    await expect(page.getByRole('heading', { name: 'Not allowed' })).toBeVisible();
  });

  test('unanswered questions come first and show who asked', async ({ page }) => {
    await ops(page);
    await expect(page.getByRole('heading', { level: 1, name: /operations/ })).toBeVisible();
    const inbox = page.getByRole('list', { name: 'Inbox' });
    await expect(inbox.getByRole('listitem').first()).toContainText('amy · Problem B · Waiting');
    await expect(inbox.getByRole('listitem').nth(1)).toContainText(
      'zed · General · Answered (public)',
    );
    await expect(page.getByText('(1 waiting')).toBeVisible();
  });

  test('FR-CONT-04: answer privately, then for everyone', async ({ page }) => {
    const st = await ops(page);
    await page.getByRole('button', { name: /Is the grid always square/ }).click();
    const form = page.getByRole('form', { name: 'Answer' });
    await form.getByRole('textbox', { name: 'Answer' }).fill('Yes, always.');
    await form.getByRole('button', { name: 'Send answer' }).click();
    await expect
      .poll(() => st.answered)
      .toEqual([{ id: 'q1', body: { answer: 'Yes, always.', isPublic: false } }]);
    await expect(page.getByRole('status').filter({ hasText: 'Answer sent to amy.' })).toBeVisible();
    await expect(page.getByText('(0 waiting')).toBeVisible();
    // Edit it and make it public.
    await page.getByRole('button', { name: /Is the grid always square/ }).click();
    await page.getByLabel('Public: show this question and answer to every contestant').check();
    await page.getByRole('button', { name: 'Update answer' }).click();
    await expect
      .poll(() => st.answered.at(-1))
      .toEqual({ id: 'q1', body: { answer: 'Yes, always.', isPublic: true } });
    await expect(
      page.getByRole('status').filter({ hasText: 'Answer sent to everyone.' }),
    ).toBeVisible();
  });

  test('a new question arrives live', async ({ page }) => {
    await ops(page);
    await streamOpen(page, `admin:contest:${ID}:clar`);
    await emit(
      page,
      'clar',
      'clar.new',
      '6-0',
      {
        contestId: ID,
        item: {
          ...item('q9', {
            question: 'Brand new?',
            problemLabel: 'A',
            createdAt: '2026-10-10T13:50:00.000Z',
          }),
          askerId: 'u5',
          askerHandle: 'cy',
        },
      },
      `admin:contest:${ID}:clar`,
    );
    await expect(page.getByRole('list', { name: 'Inbox' })).toContainText(
      'cy · Problem A · Waiting',
    );
    await expect(page.getByText('(2 waiting')).toBeVisible();
  });

  test('j and k move through the inbox, r jumps to the answer box', async ({ page }) => {
    await ops(page);
    await page.getByRole('heading', { level: 1 }).click();
    await page.keyboard.press('j');
    await expect(page.getByRole('form', { name: 'Answer' })).toContainText('amy');
    await page.keyboard.press('j');
    await expect(page.getByRole('form', { name: 'Answer' })).toContainText('zed');
    await page.keyboard.press('k');
    await expect(page.getByRole('form', { name: 'Answer' })).toContainText('amy');
    await page.keyboard.press('r');
    await expect(page.getByRole('textbox', { name: 'Answer' })).toBeFocused();
    // Typing j in the box does not move the selection.
    await page.keyboard.type('jjj');
    await expect(page.getByRole('textbox', { name: 'Answer' })).toHaveValue('jjj');
    await expect(page.getByRole('form', { name: 'Answer' })).toContainText('amy');
  });

  test('announce to everyone', async ({ page }) => {
    const st = await ops(page);
    await page.getByLabel('Message').fill('Water is in the corridor.');
    await page.getByRole('button', { name: 'Send announcement' }).click();
    await expect.poll(() => st.announced).toEqual(['Water is in the corridor.']);
    await expect(
      page
        .getByRole('status')
        .filter({ hasText: 'Announcement sent to every registered contestant.' }),
    ).toBeVisible();
    await expect(page.getByLabel('Message')).toHaveValue('');
  });
});

for (const theme of ['dark', 'light'] as const) {
  for (const size of [
    { width: 1280, height: 800 },
    { width: 390, height: 844 },
  ]) {
    test(`C-05 a11y: drawer and ops console, ${theme}, ${size.width}px, no page-level horizontal scroll`, async ({
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
      await stubContests(page, RUNNING);
      const check = async (what: string) => {
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
          `${what} overflows`,
        ).toBeLessThanOrEqual(0);
        const r = await new AxeBuilder({ page })
          .withTags(['wcag2a', 'wcag2aa', 'wcag21aa', 'wcag22aa'])
          .exclude('.monaco-editor')
          .analyze();
        const serious = r.violations.filter(
          (v) => v.impact === 'serious' || v.impact === 'critical',
        );
        expect(
          serious.map(
            (v) => `${what} ${v.id}: ${v.nodes.map((n) => n.target.join(' ')).join(' | ')}`,
          ),
        ).toEqual([]);
      };
      await page.goto('/c/warm-up-1/A');
      await expect(page.getByRole('heading', { level: 1, name: 'A. Chai Bill' })).toBeVisible();
      await drawerButton(page).click();
      await expect(page.getByRole('dialog', { name: 'Clarifications' })).toBeVisible();
      await check('drawer');
      await page.goto(`/admin/contests/${ID}/ops`);
      await page.getByRole('button', { name: /Is the grid always square/ }).click();
      await expect(page.getByRole('form', { name: 'Answer' })).toBeVisible();
      await check('ops');
      await ctx.close();
    });
  }
}
