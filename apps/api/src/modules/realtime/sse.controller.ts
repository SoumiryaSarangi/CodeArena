import { Controller, Get, Headers, Inject, Query, Req, Res } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { ProblemError } from '../../common/problem';
import { CONFIG, type Config } from '../../config/config';
import { Public } from '../auth/guards';
import { Connection, MAX_TOPICS, SseHub } from './sse.hub';
import { TicketsService } from './tickets.service';

const STREAM_ID = /^[0-9]+-[0-9]+$/;

const Query_ = z
  .object({
    ticket: z.string().min(1).max(200),
    topics: z
      .string()
      .transform((v) => [
        ...new Set(
          v
            .split(',')
            .map((t) => t.trim())
            .filter(Boolean),
        ),
      ])
      .pipe(z.array(z.string().max(200)).min(1).max(MAX_TOPICS)),
    lastEventId: z.string().regex(STREAM_ID).optional(),
  })
  .strict();

@ApiTags('realtime')
@Controller('sse')
export class SseController {
  constructor(
    @Inject(TicketsService) private readonly tickets: TicketsService,
    @Inject(SseHub) private readonly hub: SseHub,
    @Inject(CONFIG) private readonly config: Config,
  ) {}

  /**
   * FR-RT-01..03: `GET /sse?ticket=&topics=a,b`. The ticket (single use, 60 s) fixes who is asking
   * and which topics they may watch. `Last-Event-ID` (header, as EventSource sends it) resumes.
   */
  @Public()
  @Get()
  async stream(
    @Req() req: Request,
    @Res() res: Response,
    @Query() query: unknown,
    @Headers('last-event-id') header?: string,
  ) {
    const q = Query_.parse(query);
    const last = header ?? q.lastEventId ?? null;
    if (last !== null && !STREAM_ID.test(last)) {
      throw new ProblemError('validation', 'Last-Event-ID is not an event id', {
        errors: [{ path: 'Last-Event-ID', message: 'not an event id' }],
      });
    }
    const granted = await this.tickets.redeem(q.ticket, q.topics);
    if (!granted) throw new ProblemError('unauthorized', 'The ticket is invalid, used or expired');

    res.status(200).set({
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no', // tell proxies not to hold the stream back
    });
    res.flushHeaders();
    const conn = new Connection(granted.uid, q.topics, res, last);
    res.write('retry: 3000\n\n');
    conn.timer = setInterval(() => this.hub.ping(conn), this.config.SSE_PING_MS);
    const done = () => this.hub.detach(conn);
    req.on('close', done);
    res.on('error', done);
    try {
      await this.hub.attach(conn);
    } catch (err) {
      this.hub.close(conn, 'error');
      throw err;
    }
  }
}
