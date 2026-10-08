import { Module } from '@nestjs/common';
import { SubmissionsModule } from '../submissions/submissions.module';
import { AiCache } from './cache';
import { HintsController } from './hints/hints.controller';
import { HintsService } from './hints/hints.service';
import { AiLedger } from './ledger';
import { AiQueue } from './queue';
import { AiRouter } from './router';
import { ReviewsController } from './reviews/reviews.controller';
import { ReviewsService } from './reviews/reviews.service';

// AI-01: the provider layer every AI feature goes through. AI-02: the hint ladder. AI-03: post-contest reviews.
@Module({
  imports: [SubmissionsModule],
  controllers: [HintsController, ReviewsController],
  providers: [AiLedger, AiRouter, AiCache, AiQueue, HintsService, ReviewsService],
  exports: [AiLedger, AiRouter, AiCache, AiQueue, HintsService, ReviewsService],
})
export class AiModule {}
