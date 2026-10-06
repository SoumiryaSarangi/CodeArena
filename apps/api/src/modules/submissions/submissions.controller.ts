import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  Inject,
  Param,
  Post,
  Query,
  Req,
} from '@nestjs/common';
import {
  CreateRun,
  CreateSubmission,
  SubmissionListQuery,
  type RunCreated,
  type RunResult,
  type SubmissionCreated,
} from '@codearena/contracts';
import type { Request } from 'express';
import { RequireHandle } from '../auth/guards';
import { RateLimit } from '../../rate-limit/rate-limit';
import { Idempotency } from './idempotency';
import { SubmissionsService } from './submissions.service';

@Controller()
export class SubmissionsController {
  constructor(
    @Inject(SubmissionsService) private readonly service: SubmissionsService,
    @Inject(Idempotency) private readonly idempotency: Idempotency,
  ) {}

  /** FR-SUB-04: 6 per minute per user. */
  @RequireHandle()
  @RateLimit({ scope: 'submit', perMinute: 6 })
  @Post('submissions')
  @HttpCode(201)
  submit(
    @Req() req: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ): Promise<SubmissionCreated> {
    const input = CreateSubmission.parse(body);
    return this.idempotency.once('submit', req.user!.id, key, () =>
      this.service.submit(req.user!.id, input),
    );
  }

  @Get('submissions')
  list(@Req() req: Request, @Query() query: unknown) {
    return this.service.list(req.user!, SubmissionListQuery.parse(query));
  }

  @Get('submissions/:id')
  detail(@Req() req: Request, @Param('id') id: string) {
    return this.service.detail(req.user!, id);
  }

  @Get('submissions/:id/position')
  position(@Req() req: Request, @Param('id') id: string) {
    return this.service.position(req.user!, id);
  }

  /** FR-SUB-04: 12 per minute per user. */
  @RequireHandle()
  @RateLimit({ scope: 'run', perMinute: 12 })
  @Post('runs')
  @HttpCode(201)
  run(
    @Req() req: Request,
    @Body() body: unknown,
    @Headers('idempotency-key') key?: string,
  ): Promise<RunCreated> {
    const input = CreateRun.parse(body);
    return this.idempotency.once('run', req.user!.id, key, () =>
      this.service.run(req.user!.id, input),
    );
  }

  @Get('runs/:id')
  runResult(@Req() req: Request, @Param('id') id: string): Promise<RunResult> {
    return this.service.runResult(req.user!.id, id);
  }
}
