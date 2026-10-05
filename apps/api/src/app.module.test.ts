import { describe, expect, it } from 'vitest';
import { HealthController } from './app.module';

describe('api', () => {
  it('hello: healthz returns ok', () => {
    expect(new HealthController().health()).toEqual({ status: 'ok', service: 'api' });
  });
});
