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
import { MessagesService } from './messages.service';

/** Contests for contestants and guests (SRS §3.2.7). A bearer token, when sent, adds `registered`. */
@Controller('contests')
export class ContestsController {
  constructor(
    @Inject(ContestsService) private readonly contests: ContestsService,
    @Inject(MessagesService) private readonly messages: MessagesService,
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

  @Public()
  @Get(':slug/board')
  board(@Req() req: Request, @Param('slug') slug: string) {
    return this.contests.boardOf(slug, req.user);
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
  ) {}

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
