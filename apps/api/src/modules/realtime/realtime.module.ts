import { Module } from '@nestjs/common';
import { SubmissionsModule } from '../submissions/submissions.module';
import { ProgressBridge } from './progress.bridge';
import { SseController } from './sse.controller';
import { SseHub } from './sse.hub';
import { TicketsController } from './tickets.controller';
import { TicketsService } from './tickets.service';

@Module({
  imports: [SubmissionsModule],
  controllers: [TicketsController, SseController],
  providers: [TicketsService, SseHub, ProgressBridge],
  exports: [TicketsService, SseHub, ProgressBridge],
})
export class RealtimeModule {}
