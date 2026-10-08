import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { RateHint } from '@codearena/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { RequireHandle } from '../../auth/guards';
import { ReviewsService } from './reviews.service';

const ListQuery = z.object({ contest: z.string().min(1).max(100) }).strict();
const Id = z.uuid();

@Controller('reviews')
export class ReviewsController {
  constructor(@Inject(ReviewsService) private readonly service: ReviewsService) {}

  /** My reviews for a finalised contest: one per attempted problem, with their status. */
  @Get()
  list(@Req() req: Request, @Query() query: unknown) {
    return this.service.list(req.user!.id, ListQuery.parse(query).contest);
  }

  /** Opening a review writes it if it is not there yet (owner only). */
  @RequireHandle()
  @Get('by-submission/:id')
  open(@Req() req: Request, @Param('id') id: string) {
    return this.service.open(req.user!.id, Id.parse(id));
  }

  @RequireHandle()
  @Post(':id/rating')
  @HttpCode(204)
  async rate(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    await this.service.rate(req.user!.id, Id.parse(id), RateHint.parse(body).helpful);
  }
}
