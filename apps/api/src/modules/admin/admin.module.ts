import { Module } from '@nestjs/common';
import { ProblemsModule } from '../problems/problems.module';
import { SubmissionsModule } from '../submissions/submissions.module';
import { AdminController } from './admin.controller';
import { AdminProblemsService } from './admin-problems.service';

// UI-04: the setter/admin problem screens' API. Validation runs live in SubmissionsModule because
// their verdicts arrive through the same results stream as submissions.
@Module({
  imports: [ProblemsModule, SubmissionsModule],
  controllers: [AdminController],
  providers: [AdminProblemsService],
})
export class AdminModule {}
