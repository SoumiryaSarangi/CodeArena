import { Body, Controller, HttpCode, Inject, Param, Post, UseGuards } from '@nestjs/common';
import { CollabAuthorizeRequest } from '@codearena/contracts';
import { z } from 'zod';
import { Public, SkipCsrf } from '../auth/guards';
import { CollabTokenGuard } from '../plag/service-token.guard';
import { CollabService } from './collab.service';

const RoomId = z.uuid();

/**
 * The collab server (service token, no user, no browser): who does this ticket belong to? Under `internal/`, which is
 * for services on the private network; the edge should not route it (follow-up with the collab deployment).
 */
@Public()
@SkipCsrf()
@UseGuards(CollabTokenGuard)
@Controller('internal/rooms')
export class CollabController {
  constructor(@Inject(CollabService) private readonly collab: CollabService) {}

  @Post(':id/authorize')
  @HttpCode(200)
  authorize(@Param('id') id: string, @Body() body: unknown) {
    return this.collab.authorize(RoomId.parse(id), CollabAuthorizeRequest.parse(body).ticket);
  }
}
