import { Module } from '@nestjs/common';
import { SubmissionsModule } from '../submissions/submissions.module';
import { AiCache } from './cache';
import { AiLedger } from './ledger';
import { AiQueue } from './queue';
import { AiRouter } from './router';

// AI-01: the provider layer every AI feature (hints, reviews, summaries, evals) goes through.
@Module({
  imports: [SubmissionsModule],
  providers: [AiLedger, AiRouter, AiCache, AiQueue],
  exports: [AiLedger, AiRouter, AiCache, AiQueue],
})
export class AiModule {}
