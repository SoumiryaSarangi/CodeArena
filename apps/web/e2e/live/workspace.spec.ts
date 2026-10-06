import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

/**
 * UI-02 against the real stack: sign in with a minted session, open a problem, run a sample, submit
 * a correct solution and watch the judge give AC; then a wrong one and see WA on the right test.
 * Needs: docker compose up, the API on :4000 (pnpm dev), a judge worker, and the 20 problems
 * imported (`pnpm problem:import --publish problems/`). Skipped unless E2E_LIVE=1.
 */
test.skip(
  process.env.E2E_LIVE !== '1',
  'set E2E_LIVE=1 and start the stack (see e2e/live/README.md)',
);

const CPP_OK = [
  '#include <bits/stdc++.h>',
  'int main(){long long a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}',
].join('\n');
const CPP_WA = [
  '#include <bits/stdc++.h>',
  'int main(){int a,b;std::cin>>a>>b;std::cout<<a+b<<"\\n";}', // 32-bit overflow on the big tests
].join('\n');

function mintSession(): { userId: string; handle: string; refreshToken: string } {
  const out = execFileSync(
    'pnpm',
    ['--filter', '@codearena/api', 'exec', 'tsx', 'src/test/mint-session.ts'],
    {
      encoding: 'utf8',
    },
  );
  return JSON.parse(out.trim().split('\n').at(-1)!);
}

async function setCode(page: import('@playwright/test').Page, code: string) {
  // Put the code in through the editor's own API: typing a whole program through key events is slow
  // and Monaco's auto-closing brackets would mangle it. This is what pasting does.
  await page.locator('.monaco-editor .view-lines').first().click();
  await page.keyboard.press('Control+A');
  await page.evaluate(async (text) => {
    await navigator.clipboard.writeText(text).catch(() => {});
  }, code);
  await page.keyboard.press('Control+V');
}

test('UI-02 live: sign in, run a sample, submit AC, submit WA', async ({ page, context }) => {
  const s = mintSession();
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await context.addCookies([
    {
      name: 'ca_rt',
      value: s.refreshToken,
      url: 'http://localhost:3123/api/auth',
      httpOnly: true,
      secure: true,
      sameSite: 'Lax',
    },
  ]);

  await page.goto('/p/sum-two-numbers');
  await expect(page.getByRole('link', { name: s.handle })).toBeVisible({ timeout: 30_000 }); // signed in
  await page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 60_000 });
  await expect(page.locator('.katex').first()).toBeVisible();

  // Run sample 1 with a correct program: the real judge compiles and runs it.
  await setCode(page, CPP_OK);
  await page.getByRole('button', { name: 'Run this sample' }).first().click();
  const card = page.getByRole('region', { name: 'Sample 1' }).last();
  await expect(card.getByText('Matches the expected output')).toBeVisible({ timeout: 60_000 });

  // Submit it: queue → judging → AC on all tests.
  await page.getByRole('button', { name: /^Submit/ }).click();
  await expect(page.getByRole('tab', { name: 'Tests' })).toHaveAttribute('data-state', 'active');
  const panel = page.getByRole('tabpanel');
  await expect(panel.getByText('AC', { exact: true }).first()).toBeVisible({ timeout: 90_000 });
  await expect(panel.getByText('Accepted').first()).toBeVisible();
  await expect(page.getByRole('link', { name: 'Details →' })).toBeVisible();
  const tests = page.getByRole('list', { name: 'Test results' }).getByRole('listitem');
  expect(await tests.count()).toBeGreaterThan(5);
  for (const t of await tests.all()) await expect(t).toHaveAttribute('aria-label', /· AC/);

  // The detail page: the journey was recorded from the real worker's progress events.
  await page.getByRole('link', { name: 'Details →' }).click();
  await expect(page).toHaveURL(/\/s\/[0-9a-f-]{36}$/);
  const journey = page.getByRole('region', { name: 'Journey' });
  await expect(journey.getByText('by live-w1')).toBeVisible({ timeout: 15_000 });
  for (const label of ['Submitted', 'Claimed', 'Compiled', 'Tests', 'Verdict published'])
    await expect(journey.getByText(label, { exact: true })).toBeVisible();
  await expect(journey.getByText(/in \d/)).toBeVisible(); // how long compiling took
  await expect(page.getByRole('region', { name: 'Tests' }).getByRole('row')).toHaveCount(13); // header + 12
  await expect(journey.getByText('Step timings were not recorded')).toHaveCount(0);
  await page.goBack();
  await page.locator('.monaco-editor .view-lines').first().waitFor({ timeout: 60_000 });

  // A wrong program (32-bit overflow): WA, and the grid shows which test.
  await setCode(page, CPP_WA);
  await page.getByRole('button', { name: /^Submit/ }).click();
  await expect(page.getByText(/Wrong answer on test \d+/).first()).toBeVisible({ timeout: 90_000 });

  // Both attempts are in My submissions.
  await page.getByRole('tab', { name: 'Submissions' }).click();
  await expect(page.getByRole('row').filter({ hasText: 'cpp17' })).toHaveCount(2, {
    timeout: 15_000,
  });
});
