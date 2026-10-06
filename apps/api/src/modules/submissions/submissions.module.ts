import { Module } from '@nestjs/common';
import { QUEUE_KEY_PREFIX, QueueService } from './queue.service';

// The card that owns the submit endpoint adds its controller here; QueueService is the enqueue side (Q-01).
@Module({
  providers: [{ provide: QUEUE_KEY_PREFIX, useValue: '' }, QueueService],
  exports: [QueueService],
})
export class SubmissionsModule {}
