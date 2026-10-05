import { describe, expect, it } from 'vitest';
import { HealthSchema } from './index';

describe('contracts', () => {
  it('hello: health schema accepts ok payload', () => {
    expect(HealthSchema.parse({ status: 'ok', service: 'api' }).status).toBe('ok');
  });
});
