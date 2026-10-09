import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import {
  ContestExtend,
  ContestProblemCanary,
  ContestProblemVisibility,
  Rejudge,
} from '@codearena/contracts';
import type { Request } from 'express';
import { Roles } from '../auth/guards';
import { OpsService } from './ops.service';

/** C-07 (S16): contest operations and queue visibility. Admin only. */
@Roles('admin')
@Controller('admin')
export class OpsController {
  constructor(@Inject(OpsService) private readonly ops: OpsService) {}

  @Post('contests/:id/extend')
  @HttpCode(200)
  extend(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.ops.extend(id, req.user!, ContestExtend.parse(body));
  }

  @Post('contests/:id/problems/:label/visibility')
  @HttpCode(200)
  visibility(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('label') label: string,
    @Body() body: unknown,
  ) {
    return this.ops.setHidden(id, label, ContestProblemVisibility.parse(body).hidden, req.user!);
  }

  /** IN-02: the optional canary instruction for one problem (off by default). */
  @Post('contests/:id/problems/:label/canary')
  @HttpCode(200)
  canary(
    @Req() req: Request,
    @Param('id') id: string,
    @Param('label') label: string,
    @Body() body: unknown,
  ) {
    return this.ops.setCanary(id, label, ContestProblemCanary.parse(body).enabled, req.user!);
  }

  @Post('rejudge')
  @HttpCode(200)
  rejudge(@Req() req: Request, @Body() body: unknown) {
    return this.ops.rejudge(req.user!, Rejudge.parse(body));
  }

  @Get('ops/summary')
  summary() {
    return this.ops.summary();
  }

  @Get('dlq')
  dlq() {
    return this.ops.dlq();
  }

  @Post('dlq/:entryId/requeue')
  @HttpCode(200)
  requeue(@Req() req: Request, @Param('entryId') entryId: string) {
    return this.ops.requeue(entryId, req.user!);
  }
}
