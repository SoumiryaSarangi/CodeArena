import { Body, Controller, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { RoomCreate, RoomInviteCreate, RoomJoin } from '@codearena/contracts';
import type { Request } from 'express';
import { z } from 'zod';
import { RateLimit } from '../../rate-limit/rate-limit';
import { RequireHandle } from '../auth/guards';
import { RoomsService } from './rooms.service';

const Id = z.uuid();

/** CP-02 (SRS §3.1.2): interview rooms. Signed-in users with a handle; what each may do is decided per room. */
@RequireHandle()
@Controller('rooms')
export class RoomsController {
  constructor(@Inject(RoomsService) private readonly rooms: RoomsService) {}

  @RateLimit({ scope: 'room-create', perMinute: 10 })
  @Post()
  @HttpCode(201)
  create(@Req() req: Request, @Body() body: unknown) {
    return this.rooms.create(req.user!, RoomCreate.parse(body));
  }

  @Get()
  list(@Req() req: Request) {
    return this.rooms.list(req.user!);
  }

  // Declared before `:id` so "join" is not read as a room id.
  @RateLimit({ scope: 'room-join', perMinute: 20 })
  @Post('join')
  @HttpCode(200)
  join(@Req() req: Request, @Body() body: unknown) {
    return this.rooms.join(req.user!, RoomJoin.parse(body).token);
  }

  @Get(':id')
  get(@Req() req: Request, @Param('id') id: string) {
    return this.rooms.get(req.user!, Id.parse(id));
  }

  @RateLimit({ scope: 'room-invite', perMinute: 20 })
  @Post(':id/invites')
  @HttpCode(201)
  invite(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.rooms.invite(req.user!, Id.parse(id), RoomInviteCreate.parse(body));
  }

  @Post(':id/close')
  @HttpCode(200)
  close(@Req() req: Request, @Param('id') id: string) {
    return this.rooms.close(req.user!, Id.parse(id));
  }
}
