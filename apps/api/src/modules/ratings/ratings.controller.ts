import { Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public, Roles } from '../auth/guards';
import { RatingsService } from './ratings.service';

/** Final results and rating history: public once final. */
@Controller()
export class RatingsPublicController {
  constructor(@Inject(RatingsService) private readonly ratings: RatingsService) {}

  @Public()
  @Get('contests/:slug/results')
  results(@Param('slug') slug: string) {
    return this.ratings.results(slug);
  }

  @Public()
  @Get('users/:handle/ratings')
  history(@Param('handle') handle: string) {
    return this.ratings.history(handle);
  }
}

@Roles('admin')
@Controller('admin/contests')
export class RatingsAdminController {
  constructor(@Inject(RatingsService) private readonly ratings: RatingsService) {}

  @Post(':id/finalize')
  @HttpCode(200)
  finalize(@Req() req: Request, @Param('id') id: string) {
    return this.ratings.finalize(id, req.user!);
  }

  @Post(':id/recompute-ratings')
  @HttpCode(200)
  recompute(@Req() req: Request, @Param('id') id: string) {
    return this.ratings.recompute(id, req.user!);
  }
}
