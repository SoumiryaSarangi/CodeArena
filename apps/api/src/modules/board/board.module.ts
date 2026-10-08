import { Module } from '@nestjs/common';
import { BoardService } from './board.service';

// C-02: the contest leaderboard. Its own module so SubmissionsModule (verdicts, submits) and
// ContestsModule (registration, reads) both use it without depending on each other.
@Module({
  providers: [BoardService],
  exports: [BoardService],
})
export class BoardModule {}
