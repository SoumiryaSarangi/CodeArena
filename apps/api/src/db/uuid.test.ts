import { describe, expect, it } from 'vitest';
import { uuidv7 } from './uuid';

describe('uuidv7', () => {
  it('F-04: has version 7 and RFC variant bits', () => {
    expect(uuidv7()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('F-04: sorts by creation time', () => {
    const ids = [1_000, 2_000, 3_000].map((t) => uuidv7(t));
    expect([...ids].sort()).toEqual(ids);
  });
});
