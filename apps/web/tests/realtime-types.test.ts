import { SseEventType } from '@codearena/contracts';
import { describe, expect, it } from 'vitest';
import { TYPES } from '@/lib/realtime';

describe('FR-RT-01: the browser listens for every event type the server can send', () => {
  it('lists each SseEventType (an event type the client does not subscribe to is silently dropped)', () => {
    expect([...TYPES].sort()).toEqual([...SseEventType.options].sort());
  });
});
