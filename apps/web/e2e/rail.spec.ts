import { expect, test } from '@playwright/test';
import { stubApi } from './stub-api';

test('UI: Profile sits at the bottom of the side rail, with Admin above it for staff', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await stubApi(page, { role: 'admin' });
  await page.goto('/home');
  const nav = page.getByRole('navigation', { name: 'Main' });
  const y = async (name: string) => (await nav.getByRole('link', { name }).boundingBox())!.y;
  const [home, interview, admin, profile] = [
    await y('Home'),
    await y('Interview'),
    await y('Admin'),
    await y('Profile'),
  ];
  expect(home).toBeLessThan(interview);
  expect(admin).toBeGreaterThan(interview + 100); // pushed down, not next to the others
  expect(profile).toBeGreaterThan(admin);
  // the last thing in the rail, near the bottom of the window
  expect(profile).toBeGreaterThan(800 - 120);
});

test('UI: on a phone the bottom bar keeps its order with Profile last', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await stubApi(page);
  await page.goto('/home');
  const names = await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link')
    .evaluateAll((a) => a.map((e) => e.getAttribute('aria-label')));
  expect(names).toEqual(['Home', 'Practice', 'Contests', 'Interview', 'Profile']);
});
