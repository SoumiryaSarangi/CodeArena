import { describe, expect, it } from 'vitest';
import { createServer } from './server';

describe('collab', () => {
  it('hello: server can be constructed', () => {
    expect(createServer(0)).toBeDefined();
  });
});
