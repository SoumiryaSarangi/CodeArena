import { Controller, Get, Inject, Param, Query } from '@nestjs/common';
import { ProblemListQuery } from '@codearena/contracts';
import { Public } from '../auth/guards';
import { ProblemsService } from './problems.service';

@Controller('problems')
export class ProblemsController {
  constructor(@Inject(ProblemsService) private readonly problems: ProblemsService) {}

  @Public()
  @Get()
  list(@Query() query: unknown) {
    return this.problems.list(ProblemListQuery.parse(query));
  }

  @Public()
  @Get(':slug')
  detail(@Param('slug') slug: string) {
    return this.problems.detail(slug);
  }
}
