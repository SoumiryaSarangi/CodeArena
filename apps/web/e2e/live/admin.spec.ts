import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, test } from '@playwright/test';

/**
 * UI-04 against the real stack: a setter uploads a package folder through the page, presses
 * Validate and the real judge runs every solution and the validator; the table must say every one
 * behaves as the package declares. Needs the same stack as the other live spec (e2e/live/README.md):
 * compose, the API on :4000, a judge worker with isolate. Skipped unless E2E_LIVE=1.
 */
test.skip(
  process.env.E2E_LIVE !== '1',
  'set E2E_LIVE=1 and start the stack (see e2e/live/README.md)',
);

function mintSetter(): { handle: string; refreshToken: string } {
  const out = execFileSync(
    'pnpm',
    ['--filter', '@codearena/api', 'exec', 'tsx', 'src/test/mint-session.ts', '', 'setter'],
    { encoding: 'utf8' },
  );
  return JSON.parse(out.trim().split('\n').at(-1)!);
}

test('UI-04 live: upload a package, Validate, every solution as declared', async ({
  page,
  context,
}) => {
  test.setTimeout(240_000);
  // A copy under a fresh folder name: the folder name is the problem's slug, and a problem already
  // imported from the command line has no author (only admins may change it).
  const slug = `live-hop-${Date.now().toString(36)}`;
  const tmp = mkdtempSync(join(tmpdir(), 'ca-live-'));
  const folder = join(tmp, slug);
  cpSync(resolve(__dirname, '../../../../problems/hop-distances'), folder, { recursive: true });

  const s = mintSetter();
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

  await page.goto('/admin/problems');
  await expect(page.getByRole('heading', { name: 'Problems', level: 1 })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTestId('folder-input').setInputFiles(folder);
  await expect(page.getByLabel('Problem slug')).toHaveValue(slug);
  await page.getByRole('button', { name: 'Upload package' }).click();
  await expect(page.getByText(`${slug}: created, version 1 with 10 tests.`)).toBeVisible({
    timeout: 60_000,
  });

  await page.getByRole('link', { name: slug }).click();
  await expect(page.getByRole('heading', { level: 1, name: 'Hop Distances' })).toBeVisible();
  await page.getByRole('tab', { name: 'Tests' }).click();
  await expect(page.getByText('10 tests. Only you and admins can download them.')).toBeVisible();

  await page.getByRole('tab', { name: 'Solutions & Validation' }).click();
  await page.getByRole('button', { name: 'Validate' }).click();
  await expect(page.getByText('All 8 behave as expected.')).toBeVisible({ timeout: 180_000 });
  for (const name of [
    'main.cpp',
    'alt.py',
    'wa-dfs-depth.cpp',
    'tle-bellman.cpp',
    'validator.cpp',
  ]) {
    await expect(
      page.getByRole('row', { name: new RegExp(name.replace('.', '\\.')) }),
    ).toContainText('as expected');
  }
  await expect(page.getByRole('row', { name: /tle-bellman/ })).toContainText('TLE');
  await expect(page.getByText('Validated').first()).toBeVisible();
  rmSync(tmp, { recursive: true, force: true });
});
