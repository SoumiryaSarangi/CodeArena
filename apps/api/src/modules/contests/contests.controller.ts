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
  Query,
  Req,
} from '@nestjs/common';
import {
  AnnouncementCreate,
  ClarificationAnswer,
  ClarificationCreate,
  ContestCreate,
  ContestPatch,
  ContestProblemsPut,
} from '@codearena/contracts';
import type { Request } from 'express';
import { RateLimit } from '../../rate-limit/rate-limit';
import { Public, RequireHandle, Roles } from '../auth/guards';
import { ContestsService } from './contests.service';
import { ExamService } from './exam.service';
import { MessagesService } from './messages.service';

/** Contests for contestants and guests (SRS §3.2.7). A bearer token, when sent, adds `registered`. */
@Controller('contests')
export class ContestsController {
  constructor(
    @Inject(ContestsService) private readonly contests: ContestsService,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(ExamService) private readonly exam: ExamService,
  ) {}

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

  /** FR-EXAM-01: end my test (exam-mode contests only). */
  @RequireHandle()
  @RateLimit({ scope: 'exam-finish', perMinute: 10 })
  @Post(':slug/finish')
  @HttpCode(200)
  async finish(@Req() req: Request, @Param('slug') slug: string) {
    await this.exam.finish(slug, req.user!);
    return this.contests.detail(slug, req.user);
  }

  /** FR-EXAM-02: the client saw me leave the test window; the third time finishes the test. */
  @RateLimit({ scope: 'exam-leave', perMinute: 30 })
  @Post(':slug/leave')
  @HttpCode(200)
  leave(@Req() req: Request, @Param('slug') slug: string) {
    return this.exam.leave(slug, req.user!);
  }

  @Public()
  @Get(':slug/board')
  board(@Req() req: Request, @Param('slug') slug: string, @Query('view') view?: string) {
    // `?view=frozen` is for the resolver and only changes anything for an admin (C-06).
    return this.contests.boardOf(slug, req.user, view === 'frozen' ? 'frozen' : undefined);
  }

  @Get(':slug/clarifications')
  clarifications(@Req() req: Request, @Param('slug') slug: string) {
    return this.messages.list(slug, req.user!);
  }

  @RequireHandle()
  @RateLimit({ scope: 'clarify', perMinute: 6 })
  @Post(':slug/clarifications')
  @HttpCode(201)
  ask(@Req() req: Request, @Param('slug') slug: string, @Body() body: unknown) {
    return this.messages.ask(slug, req.user!, ClarificationCreate.parse(body));
  }

  @Get(':slug/announcements')
  announcements(@Req() req: Request, @Param('slug') slug: string) {
    return this.messages.announcements(slug, req.user!);
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
  constructor(
    @Inject(ContestsService) private readonly contests: ContestsService,
    @Inject(MessagesService) private readonly messages: MessagesService,
    @Inject(ExamService) private readonly exam: ExamService,
  ) {}

  /** Who left the test window or finished (exam mode). */
  @Get(':id/exam')
  examList(@Param('id') id: string) {
    return this.exam.adminList(id);
  }

  /** Give a participant their test back. */
  @Post(':id/participants/:userId/reopen')
  @HttpCode(204)
  async reopen(@Req() req: Request, @Param('id') id: string, @Param('userId') userId: string) {
    await this.exam.reopen(id, userId, req.user!);
  }

  @Get(':id/clarifications')
  inbox(@Param('id') id: string) {
    return this.messages.inbox(id);
  }

  @Post(':id/announcements')
  @HttpCode(201)
  announce(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.messages.announce(id, req.user!, AnnouncementCreate.parse(body));
  }

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

  @Post(':id/rebuild-board')
  @HttpCode(200)
  rebuild(@Param('id') id: string) {
    return this.contests.rebuildBoard(id);
  }

  @Put(':id/problems')
  problems(@Param('id') id: string, @Body() body: unknown) {
    return this.contests.putProblems(id, ContestProblemsPut.parse(body));
  }
}

/** FR-CONT-04: admins answer a question, privately or for everyone. */
@Roles('admin')
@Controller('admin/clarifications')
export class ClarificationsAdminController {
  constructor(@Inject(MessagesService) private readonly messages: MessagesService) {}

  @Post(':id/answer')
  @HttpCode(200)
  answer(@Req() req: Request, @Param('id') id: string, @Body() body: unknown) {
    return this.messages.answer(id, req.user!, ClarificationAnswer.parse(body));
  }
}
