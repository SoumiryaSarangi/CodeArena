import { describe, expect, it } from 'vitest';
import { title } from './title';

describe('web', () => {
  it('hello: home title', () => {
    expect(title).toBe('CodeArena');
  });
});
