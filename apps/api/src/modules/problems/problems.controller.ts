import { Controller, Get, Inject, Param, Query, Req } from '@nestjs/common';
import type { Request } from 'express';
import { ProblemListQuery } from '@codearena/contracts';
import { Public } from '../auth/guards';
import { ProblemsService } from './problems.service';

@Controller('problems')
export class ProblemsController {
  constructor(@Inject(ProblemsService) private readonly problems: ProblemsService) {}

  @Public()
  @Get()
  list(@Req() req: Request, @Query() query: unknown) {
    // Guests may browse; a valid bearer token adds their own progress.
    return this.problems.list(ProblemListQuery.parse(query), req.user?.id);
  }

  @Public()
  @Get('tags')
  tags() {
    return this.problems.tags();
  }

  @Public()
  @Get(':slug')
  detail(@Param('slug') slug: string) {
    return this.problems.detail(slug);
  }
}
