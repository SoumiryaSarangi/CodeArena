import { Module } from '@nestjs/common';
import { SubmissionsModule } from '../submissions/submissions.module';
import { AiCache } from './cache';
import { HintsController } from './hints/hints.controller';
import { HintsService } from './hints/hints.service';
import { AiLedger } from './ledger';
import { AiQueue } from './queue';
import { AiRouter } from './router';

// AI-01: the provider layer every AI feature goes through. AI-02: the hint ladder.
@Module({
  imports: [SubmissionsModule],
  controllers: [HintsController],
  providers: [AiLedger, AiRouter, AiCache, AiQueue, HintsService],
  exports: [AiLedger, AiRouter, AiCache, AiQueue, HintsService],
})
export class AiModule {}
