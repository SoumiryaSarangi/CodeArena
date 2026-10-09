import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { PlagDecisionCreate, PlagFail, PlagResults, PlagRunCreate } from '@codearena/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { Public, Roles, SkipCsrf } from '../auth/guards';
import { PlagService } from './plag.service';
import { ServiceTokenGuard } from './service-token.guard';

const Id = z.uuid();
const ListQuery = z.object({ contestId: z.uuid().optional() }).strict();

/** Admins: start a run, read runs and their clusters (SRS plag endpoints). */
@Roles('admin')
@Controller('admin/plag/runs')
export class PlagAdminController {
  constructor(@Inject(PlagService) private readonly plag: PlagService) {}

  @Post()
  @HttpCode(201)
  create(@Req() req: Request, @Body() body: unknown) {
    return this.plag.create(req.user!.id, PlagRunCreate.parse(body));
  }

  @Get()
  list(@Query() query: unknown) {
    return this.plag.list(ListQuery.parse(query).contestId);
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.plag.get(Id.parse(id));
  }
}

/** Admins: one cluster for the review screen, and a decision about it (always with a note, always audited). */
@Roles('admin')
@Controller('admin/plag/clusters')
export class PlagClusterController {
  constructor(@Inject(PlagService) private readonly plag: PlagService) {}

  @Get(':id')
  get(@Param('id') id: string) {
    return this.plag.cluster(Id.parse(id));
  }

  @Post(':id/decisions')
  @HttpCode(201)
  decide(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.plag.decide(req.user!.id, Id.parse(id), PlagDecisionCreate.parse(body));
  }
}

/**
 * The plagiarism job (service token, no user, no browser): it claims a run, gets the submissions, posts the results
 * or its failure. The paths stay under `admin/plag/runs` as the SRS lists them.
 */
@Public()
@SkipCsrf()
@UseGuards(ServiceTokenGuard)
@Controller('admin/plag/runs')
export class PlagJobController {
  constructor(@Inject(PlagService) private readonly plag: PlagService) {}

  /** 200 with the work, or 204 when there is nothing to do. */
  @Post('claim')
  @HttpCode(200)
  async claim(@Req() req: Request) {
    const work = await this.plag.claim();
    if (work === null) {
      req.res!.status(204);
      return;
    }
    return work;
  }

  @Post(':id/results')
  @HttpCode(200)
  results(@Param('id') id: string, @Body() body: unknown) {
    return this.plag.results(Id.parse(id), PlagResults.parse(body));
  }

  @Post(':id/fail')
  @HttpCode(204)
  async fail(@Param('id') id: string, @Body() body: unknown) {
    await this.plag.fail(Id.parse(id), PlagFail.parse(body));
  }
}
