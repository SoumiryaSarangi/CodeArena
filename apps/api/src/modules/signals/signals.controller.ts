import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { SignalBatch } from '@codearena/contracts';
import type { Request } from 'express';
import { RateLimit } from '../../rate-limit/rate-limit';
import { SignalsService } from './signals.service';

/** IN-01: the contest page's editor signals (FR-SIG-01). Signed-in users only; 204 whatever was stored. */
@Controller('signals')
export class SignalsController {
  constructor(@Inject(SignalsService) private readonly signals: SignalsService) {}

  @RateLimit({ scope: 'signals', perMinute: 30 })
  @Post()
  @HttpCode(204)
  async record(@Req() req: Request, @Body() body: unknown): Promise<void> {
    await this.signals.record(req.user!, SignalBatch.parse(body));
  }
}
