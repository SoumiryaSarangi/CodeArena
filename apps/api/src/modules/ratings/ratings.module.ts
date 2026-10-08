import { Module } from '@nestjs/common';
import { BoardModule } from '../board/board.module';
import { RatingsAdminController, RatingsPublicController } from './ratings.controller';
import { RatingsService } from './ratings.service';

// C-08: finalising contests, ratings, results and rating history.
@Module({
  imports: [BoardModule],
  controllers: [RatingsPublicController, RatingsAdminController],
  providers: [RatingsService],
})
export class RatingsModule {}
