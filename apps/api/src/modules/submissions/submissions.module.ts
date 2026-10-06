import { Module } from '@nestjs/common';
import { CONFIG, type Config } from '../../config/config';
import { Reconciler } from './reconciler';
import { Idempotency } from './idempotency';
import { QueuePositionService } from './queue-position.service';
import { SubmissionsController } from './submissions.controller';
import { SubmissionsService } from './submissions.service';
import { QUEUE_KEY_PREFIX, QueueService } from './queue.service';
import { ResultsConsumer } from './results.consumer';
import { ResultsProcessor } from './results.processor';

// S-01: submit/run/list/detail/position endpoints. // QueueService is the enqueue side (Q-01); ResultsConsumer/ResultsProcessor the verdict side (Q-03).
@Module({
  controllers: [SubmissionsController],
  providers: [
    Idempotency,
    QueuePositionService,
    SubmissionsService,
    { provide: QUEUE_KEY_PREFIX, inject: [CONFIG], useFactory: (c: Config) => c.QUEUE_KEY_PREFIX },
    QueueService,
    ResultsProcessor,
    ResultsConsumer,
    Reconciler,
  ],
  exports: [
    QUEUE_KEY_PREFIX,
    QueueService,
    QueuePositionService,
    SubmissionsService,
    ResultsProcessor,
    ResultsConsumer,
    Reconciler,
  ],
})
export class SubmissionsModule {}
