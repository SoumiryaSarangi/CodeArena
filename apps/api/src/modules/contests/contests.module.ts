import { Module } from '@nestjs/common';
import { BoardModule } from '../board/board.module';
import {
  ClarificationsAdminController,
  ContestsAdminController,
  ContestsController,
} from './contests.controller';
import { ContestsService } from './contests.service';
import { MessagesService } from './messages.service';

// C-01: contest model, registration, contest-scoped problem access and the admin CRUD. The lane
// choice for a contest submission lives in SubmissionsService (it needs the queue).
@Module({
  imports: [BoardModule],
  controllers: [ContestsController, ContestsAdminController, ClarificationsAdminController],
  providers: [ContestsService, MessagesService],
  exports: [ContestsService],
})
export class ContestsModule {}
