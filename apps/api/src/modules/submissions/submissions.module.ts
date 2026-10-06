import { Module } from '@nestjs/common';
import { QUEUE_KEY_PREFIX, QueueService } from './queue.service';
import { ResultsConsumer } from './results.consumer';
import { ResultsProcessor } from './results.processor';

// The card that owns the submit endpoint adds its controller here.
// QueueService is the enqueue side (Q-01); ResultsConsumer/ResultsProcessor the verdict side (Q-03).
@Module({
  providers: [
    { provide: QUEUE_KEY_PREFIX, useValue: '' },
    QueueService,
    ResultsProcessor,
    ResultsConsumer,
  ],
  exports: [QueueService, ResultsProcessor, ResultsConsumer],
})
export class SubmissionsModule {}
