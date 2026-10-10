import { expect, test } from '@playwright/test';
import { stubApi } from './stub-api';

test('UI-25: the page links the favicon, the Apple touch icon and the manifest, and every one of them is served', async ({
  page,
  request,
}) => {
  await stubApi(page, { signedIn: false });
  await page.goto('/');
  const href = (sel: string) => page.locator(sel).first().getAttribute('href');
  expect(await href('link[rel="manifest"]')).toBe('/manifest.webmanifest');
  expect(await href('link[rel="apple-touch-icon"]')).toMatch(/^\/apple-icon\.png/);
  expect(await href('link[rel="icon"]')).toMatch(/\/icon\.svg/);
  const m = await request.get('/manifest.webmanifest');
  expect(m.status()).toBe(200);
  const body = (await m.json()) as { icons: { src: string; type: string }[]; name: string };
  expect(body.name).toBe('CodeArena');
  for (const i of body.icons) {
    const r = await request.get(i.src);
    expect(r.status(), i.src).toBe(200);
    expect(r.headers()['content-type']).toContain(i.type);
  }
  for (const url of [
    (await href('link[rel="apple-touch-icon"]'))!,
    (await href('link[rel="icon"]'))!,
  ])
    expect((await request.get(url)).status(), url).toBe(200);
});
