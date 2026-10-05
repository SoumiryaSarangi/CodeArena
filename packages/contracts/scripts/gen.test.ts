import { expect, it } from 'vitest';
import { check } from './gen';

it('F-03: generated files are fresh', async () => {
  expect(await check()).toEqual([]);
}, 30_000);
