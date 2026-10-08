import { Module } from '@nestjs/common';
import { CONFIG, type Config } from '../../config/config';
import { BoardModule } from '../board/board.module';
import { Reconciler } from './reconciler';
import { Idempotency } from './idempotency';
import { QueuePositionService } from './queue-position.service';
import { SubmissionsController } from './submissions.controller';
import { SubmissionsService } from './submissions.service';
import { QUEUE_KEY_PREFIX, QueueService } from './queue.service';
import { ResultsConsumer } from './results.consumer';
import { ResultsProcessor } from './results.processor';
import { ValidationService } from './validation.service';

// S-01: submit/run/list/detail/position endpoints. // QueueService is the enqueue side (Q-01); ResultsConsumer/ResultsProcessor the verdict side (Q-03).
@Module({
  imports: [BoardModule],
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
    ValidationService,
  ],
  exports: [
    QUEUE_KEY_PREFIX,
    QueueService,
    QueuePositionService,
    SubmissionsService,
    ResultsProcessor,
    ResultsConsumer,
    Reconciler,
    ValidationService,
  ],
})
export class SubmissionsModule {}
