import { Module } from '@nestjs/common';
import { ProblemsController } from './problems.controller';
import { ProblemImporter } from './problems.import';
import { ProblemsService } from './problems.service';

// Reading is public (P-01); uploads go through ProblemImporter, used by `pnpm problem:import` now
// and by the setter upload endpoint later (P-02).
@Module({
  controllers: [ProblemsController],
  providers: [ProblemsService, ProblemImporter],
  exports: [ProblemsService, ProblemImporter],
})
export class ProblemsModule {}
