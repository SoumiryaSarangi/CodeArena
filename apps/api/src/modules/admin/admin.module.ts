import { Module } from '@nestjs/common';
import { ProblemsModule } from '../problems/problems.module';
import { SubmissionsModule } from '../submissions/submissions.module';
import { AdminController } from './admin.controller';
import { AdminGrantsController } from './admin-grants.controller';
import { AdminGrantsService } from './admin-grants.service';
import { AdminProblemsService } from './admin-problems.service';

// UI-04: the setter/admin problem screens' API. Validation runs live in SubmissionsModule because
// their verdicts arrive through the same results stream as submissions.
@Module({
  imports: [ProblemsModule, SubmissionsModule],
  controllers: [AdminController, AdminGrantsController],
  providers: [AdminProblemsService, AdminGrantsService],
})
export class AdminModule {}
