import { Controller, Get, Inject, Res } from '@nestjs/common';
import type { Response } from 'express';
import { Public } from '../auth/guards';
import { StatusService } from './status.service';

/** O-02: public, cached for 5 s on the server and for 5 s by browsers and the CDN. */
@Controller('status')
export class StatusController {
  constructor(@Inject(StatusService) private readonly status: StatusService) {}

  @Public()
  @Get()
  get(@Res({ passthrough: true }) res: Response) {
    res.setHeader('Cache-Control', 'public, max-age=5');
    return this.status.get();
  }
}
