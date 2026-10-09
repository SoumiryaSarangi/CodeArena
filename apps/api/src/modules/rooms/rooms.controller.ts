import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Inject,
  Param,
  Patch,
  Post,
  Put,
  Query,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  RoomCreate,
  RoomInviteCreate,
  RoomJoin,
  RoomNotesPut,
  RoomRestore,
  RoomRunCreate,
  RoomSettingsPatch,
  RoomSummaryRequest,
} from '@codearena/contracts';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { RateLimit } from '../../rate-limit/rate-limit';
import { RequireHandle } from '../auth/guards';
import { RoomNotesService } from './room-notes.service';
import { RoomPlaybackService } from './room-playback.service';
import { RoomRestoreService } from './room-restore.service';
import { RoomSummaryService } from './room-summary.service';
import { RoomSettingsService } from './room-settings.service';
import { RoomRunsService } from './room-runs.service';
import { RoomsService } from './rooms.service';

const Id = z.uuid();
const PlaybackQuery = z
  .object({
    toTs: z.string().min(1).max(40).optional(),
    toSeq: z.coerce.number().int().min(0).optional(),
    fromSeq: z.coerce.number().int().min(0).optional(),
  })
  .strict();

/** CP-02 (SRS §3.1.2): interview rooms. Signed-in users with a handle; what each may do is decided per room. */
@RequireHandle()
@Controller('rooms')
export class RoomsController {
  constructor(
    @Inject(RoomsService) private readonly rooms: RoomsService,
    @Inject(RoomRunsService) private readonly runs: RoomRunsService,
    @Inject(RoomNotesService) private readonly notes: RoomNotesService,
    @Inject(RoomPlaybackService) private readonly playback: RoomPlaybackService,
    @Inject(RoomRestoreService) private readonly restorer: RoomRestoreService,
    @Inject(RoomSettingsService) private readonly settings: RoomSettingsService,
    @Inject(RoomSummaryService) private readonly summary: RoomSummaryService,
  ) {}

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

  /** FR-PAD-08: run or submit the room's shared code. 202: the verdict arrives on the room's SSE topic. */
  @Post(':id/runs')
  @HttpCode(202)
  run(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.runs.start(req.user!, Id.parse(id), RoomRunCreate.parse(body));
  }

  @Get(':id/runs')
  runList(@Req() req: Request, @Param('id') id: string) {
    return this.runs.list(req.user!, Id.parse(id));
  }

  /** FR-EDIT-03: the interviewer switches code suggestions on or off for the room. */
  @RateLimit({ scope: 'room-settings', perMinute: 30 })
  @Patch(':id/settings')
  @HttpCode(200)
  setSettings(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.settings.patch(req.user!, Id.parse(id), RoomSettingsPatch.parse(body));
  }

  /** FR-PAD-16: the AI summary of a finished session. Interviewer only; never cached by anything. */
  @Get(':id/summary')
  @Header('Cache-Control', 'no-store')
  summaryGet(@Req() req: Request, @Param('id') id: string) {
    return this.summary.get(req.user!, Id.parse(id));
  }

  @Post(':id/summary')
  @HttpCode(200)
  @Header('Cache-Control', 'no-store')
  summaryWrite(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.summary.write(req.user!, Id.parse(id), RoomSummaryRequest.parse(body ?? {}));
  }

  /** FR-PAD-12: put the code of one of the room's runs back, as an edit everyone converges on. Interviewer only. */
  @Post(':id/restore')
  @HttpCode(200)
  restore(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.restorer.restore(req.user!, Id.parse(id), RoomRestore.parse(body));
  }

  /** FR-PAD-09: the interviewer's private notes. Never cached; nobody else gets them by any route. */
  @Get(':id/notes')
  @Header('Cache-Control', 'no-store')
  notesGet(@Req() req: Request, @Param('id') id: string) {
    return this.notes.get(req.user!, Id.parse(id));
  }

  @RateLimit({ scope: 'room-notes', perMinute: 120 })
  @Put(':id/notes')
  @Header('Cache-Control', 'no-store')
  notesSave(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.notes.save(req.user!, Id.parse(id), RoomNotesPut.parse(body));
  }

  /** FR-PAD-10: the markers of a session for the replay. Interviewer only. */
  @RateLimit({ scope: 'room-timeline', perMinute: 60 })
  @Get(':id/timeline')
  @Header('Cache-Control', 'no-store')
  timeline(@Req() req: Request, @Param('id') id: string) {
    return this.playback.timeline(req.user!, Id.parse(id));
  }

  /** FR-PAD-10: binary slice of the update log (see `RoomPlaybackService.frame`). Interviewer only. */
  @RateLimit({ scope: 'room-playback', perMinute: 240 })
  @Get(':id/playback')
  async play(
    @Req() req: Request,
    @Param('id') id: string,
    @Query() query: unknown,
    @Res({ passthrough: true }) res: Response,
  ) {
    const q = PlaybackQuery.parse(query);
    const out = await this.playback.playback(req.user!, Id.parse(id), q);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Playback-From-Seq', String(out.fromSeq));
    res.setHeader('X-Playback-To-Seq', String(out.toSeq));
    return new StreamableFile(out.body, { type: 'application/octet-stream' });
  }
}
