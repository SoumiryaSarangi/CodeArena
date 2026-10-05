import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { TicketRequest, type TicketResponse } from '@codearena/contracts';
import type { Request } from 'express';
import { ZodPipe } from '../../common/zod.pipe';
import { RateLimit } from '../../rate-limit/rate-limit';
import { Public } from '../auth/guards';
import { TicketsService } from './tickets.service';

@ApiTags('realtime')
@Controller('realtime')
export class TicketsController {
  constructor(@Inject(TicketsService) private readonly tickets: TicketsService) {}

  /** Guests may ask for public topics only; the policy lives in TicketsService. */
  @Public()
  @RateLimit({ scope: 'ticket', perMinute: 30 }) // NFR-SEC-06
  @Post('ticket')
  @HttpCode(200)
  issue(
    @Req() req: Request,
    @Body(new ZodPipe(TicketRequest)) body: TicketRequest,
  ): Promise<TicketResponse> {
    return this.tickets.issue(req.user, body);
  }
}
