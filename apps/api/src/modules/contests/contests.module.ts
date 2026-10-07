import { Module } from '@nestjs/common';
import { ContestsAdminController, ContestsController } from './contests.controller';
import { ContestsService } from './contests.service';

// C-01: contest model, registration, contest-scoped problem access and the admin CRUD. The lane
// choice for a contest submission lives in SubmissionsService (it needs the queue).
@Module({
  controllers: [ContestsController, ContestsAdminController],
  providers: [ContestsService],
  exports: [ContestsService],
})
export class ContestsModule {}
