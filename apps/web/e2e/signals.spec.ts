import { expect, test, type Page } from '@playwright/test';
import { stubApi } from './stub-api';
import { stubContests } from './stub-contests';

interface Batch {
  contest: string;
  problem: string;
  events: { kind: string; size?: number; at: string }[];
}

/** Everything the page reports to POST /api/signals, flattened. */
async function capture(page: Page) {
  const events: Batch['events'] = [];
  const batches: Batch[] = [];
  await page.route('**/api/signals', (r) => {
    const body = r.request().postDataJSON() as Batch;
    batches.push(body);
    events.push(...body.events);
    return r.fulfill({ status: 204 });
  });
  return { events, batches };
}

const editorReady = (page: Page) =>
  page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 60_000 });

test.describe('IN-01: editor signals from the contest page (FR-SIG-01)', () => {
  test('FR-SIG-01: opening a problem is reported with the contest and problem label', async ({
    page,
  }) => {
    await stubApi(page);
    await stubContests(page, { startsInSec: -30 * 60, durationMin: 180, registered: true });
    const sig = await capture(page);
    await page.goto('/c/warm-up-1/A');
    await expect.poll(() => sig.events.map((e) => e.kind)).toContain('problem_open');
    expect(sig.batches[0]).toMatchObject({ contest: 'warm-up-1', problem: 'A' });
  });

  test('FR-SIG-01: leaving and returning to the window is reported, once for a burst', async ({
    page,
  }) => {
    await stubApi(page);
    await stubContests(page, { startsInSec: -30 * 60, durationMin: 180, registered: true });
    const sig = await capture(page);
    await page.goto('/c/warm-up-1/A');
    await editorReady(page);
    await page.evaluate(() => {
      window.dispatchEvent(new Event('blur'));
      window.dispatchEvent(new Event('blur')); // a second one right away is the same departure
      window.dispatchEvent(new Event('focus'));
    });
    await expect
      .poll(() => sig.events.map((e) => e.kind), { timeout: 15_000 }) // `focus` waits for the 10 s batch
      .toEqual(expect.arrayContaining(['blur', 'focus']));
    expect(sig.events.filter((e) => e.kind === 'blur')).toHaveLength(1);
  });

  test('FR-SIG-01: a paste of more than 50 characters reports its size, a short one nothing, and never the text', async ({
    page,
    context,
  }) => {
    await context.grantPermissions(['clipboard-read', 'clipboard-write']);
    await stubApi(page);
    await stubContests(page, { startsInSec: -30 * 60, durationMin: 180, registered: true });
    const sig = await capture(page);
    await page.goto('/c/warm-up-1/A');
    await editorReady(page);
    await page.locator('.monaco-editor').first().click();
    const paste = async (text: string) => {
      await page.evaluate((t) => navigator.clipboard.writeText(t), text);
      await page.keyboard.press('ControlOrMeta+V');
    };
    await paste('short paste');
    const secret = 'x'.repeat(120);
    await paste(secret);
    await page.evaluate(() => window.dispatchEvent(new Event('blur'))); // leaving the window flushes the queue
    await expect.poll(() => sig.events.filter((e) => e.kind === 'paste')).toHaveLength(1);
    const pastes = sig.events.filter((e) => e.kind === 'paste');
    expect(pastes).toEqual([expect.objectContaining({ size: 120 })]);
    expect(JSON.stringify(sig.batches)).not.toContain(secret);
  });

  test('nothing is reported from practice, where there is no contest', async ({ page }) => {
    await stubApi(page);
    const sig = await capture(page);
    await page.goto('/p/sum-two-numbers');
    await editorReady(page);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    await page.waitForTimeout(500);
    expect(sig.batches).toEqual([]);
  });
});
