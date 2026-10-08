import { Module } from '@nestjs/common';
import { BoardModule } from '../board/board.module';
import { ContestsModule } from '../contests/contests.module';
import { SubmissionsModule } from '../submissions/submissions.module';
import { OpsController } from './ops.controller';
import { OpsService } from './ops.service';

// C-07: admin operations on contests and the judge queue.
@Module({
  imports: [BoardModule, ContestsModule, SubmissionsModule],
  controllers: [OpsController],
  providers: [OpsService],
})
export class OpsModule {}
