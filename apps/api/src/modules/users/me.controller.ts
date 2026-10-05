import { Body, Controller, Get, Inject, Param, Patch, Req } from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { PatchMe, type HandleAvailability, type Me } from '@codearena/contracts';
import type { Request } from 'express';
import { ZodPipe } from '../../common/zod.pipe';
import { UsersService } from './users.service';

@ApiTags('account')
@Controller()
export class MeController {
  constructor(@Inject(UsersService) private readonly users: UsersService) {}

  @Get('me')
  me(@Req() req: Request): Promise<Me> {
    return this.users.me(req.user!.id);
  }

  /** FR-AUTH-02 / FR-AUTH-03: choose a handle (and default language) during onboarding. */
  @Patch('me')
  update(@Req() req: Request, @Body(new ZodPipe(PatchMe)) body: PatchMe): Promise<Me> {
    return this.users.update(req.user!.id, body);
  }

  @Get('handles/:handle/available')
  available(@Param('handle') handle: string): Promise<HandleAvailability> {
    return this.users.handleAvailability(handle);
  }
}
