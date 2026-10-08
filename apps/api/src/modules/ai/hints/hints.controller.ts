import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query, Req } from '@nestjs/common';
import { CreateHint, RateHint } from '@codearena/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { RequireHandle } from '../../auth/guards';
import { RateLimit } from '../../../rate-limit/rate-limit';
import { HintsService } from './hints.service';

const StateQuery = z.object({ problemSlug: z.string().min(1).max(100) }).strict();
const Id = z.uuid();

@Controller('hints')
export class HintsController {
  constructor(@Inject(HintsService) private readonly service: HintsService) {}

  /** The ladder for one problem: what is unlocked, what each level costs, how many requests are left. */
  @Get()
  state(@Req() req: Request, @Query() query: unknown) {
    return this.service.state(req.user!.id, StateQuery.parse(query).problemSlug);
  }

  /** FR-AI-06: 10 per hour per user is enforced in the service (cached and repeated hints are free); this is a burst cap. */
  @RequireHandle()
  @RateLimit({ scope: 'hint', perMinute: 6 })
  @Post()
  @HttpCode(200)
  request(@Req() req: Request, @Body() body: unknown) {
    return this.service.request(req.user!.id, CreateHint.parse(body));
  }

  @RequireHandle()
  @Post(':id/rating')
  @HttpCode(204)
  async rate(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    await this.service.rate(req.user!.id, Id.parse(id), RateHint.parse(body).helpful);
  }
}
