import {
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Req,
} from '@nestjs/common';
import { ContestCreate, ContestPatch, ContestProblemsPut } from '@codearena/contracts';
import type { Request } from 'express';
import { RateLimit } from '../../rate-limit/rate-limit';
import { Public, RequireHandle, Roles } from '../auth/guards';
import { ContestsService } from './contests.service';

/** Contests for contestants and guests (SRS §3.2.7). A bearer token, when sent, adds `registered`. */
@Controller('contests')
export class ContestsController {
  constructor(@Inject(ContestsService) private readonly contests: ContestsService) {}

  @Public()
  @Get()
  list(@Req() req: Request) {
    return this.contests.list(req.user);
  }

  @Public()
  @Get(':slug')
  detail(@Req() req: Request, @Param('slug') slug: string) {
    return this.contests.detail(slug, req.user);
  }

  @RequireHandle()
  @RateLimit({ scope: 'contest-register', perMinute: 10 })
  @Post(':slug/register')
  @HttpCode(201)
  register(@Req() req: Request, @Param('slug') slug: string) {
    return this.contests.register(slug, req.user!.id);
  }

  @Public()
  @Get(':slug/problems')
  problems(@Req() req: Request, @Param('slug') slug: string) {
    return this.contests.problems(slug, req.user);
  }

  @Public()
  @Get(':slug/problems/:label')
  problem(@Req() req: Request, @Param('slug') slug: string, @Param('label') label: string) {
    return this.contests.problem(slug, label.toUpperCase(), req.user);
  }
}

/** FR-CONT-01: admins create and edit contests and set their problem list. */
@Roles('admin')
@Controller('admin/contests')
export class ContestsAdminController {
  constructor(@Inject(ContestsService) private readonly contests: ContestsService) {}

  @Get()
  list() {
    return this.contests.adminList();
  }

  @Get(':id')
  get(@Param('id') id: string) {
    return this.contests.adminGet(id);
  }

  @Post()
  @HttpCode(201)
  create(@Req() req: Request, @Body() body: unknown) {
    return this.contests.create(ContestCreate.parse(body), req.user!.id);
  }

  @Patch(':id')
  patch(@Param('id') id: string, @Body() body: unknown) {
    return this.contests.patch(id, ContestPatch.parse(body));
  }

  @Put(':id/problems')
  problems(@Param('id') id: string, @Body() body: unknown) {
    return this.contests.putProblems(id, ContestProblemsPut.parse(body));
  }
}
