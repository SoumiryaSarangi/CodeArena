import { Body, Controller, Delete, Get, HttpCode, Inject, Param, Post, Req } from '@nestjs/common';
import { AdminGrantAdd } from '@codearena/contracts';
import type { Request } from 'express';
import { RateLimit } from '../../rate-limit/rate-limit';
import { Roles } from '../auth/guards';
import { AdminGrantsService } from './admin-grants.service';

/**
 * Who is admin (FR-AUTH-12..14): admin-role routes whose service then checks that the caller is the
 * owner (OWNER_EMAIL), so an ordinary admin gets 403 as well.
 */
@Roles('admin')
@Controller('admin/admins')
export class AdminGrantsController {
  constructor(@Inject(AdminGrantsService) private readonly grants: AdminGrantsService) {}

  @Get()
  list(@Req() req: Request) {
    return this.grants.list(req.user!.id);
  }

  @RateLimit({ scope: 'admin-grants', perMinute: 20 })
  @Post()
  @HttpCode(204)
  async add(@Req() req: Request, @Body() body: unknown) {
    await this.grants.add(req.user!.id, AdminGrantAdd.parse(body).email);
  }

  @RateLimit({ scope: 'admin-grants', perMinute: 20 })
  @Delete(':email')
  @HttpCode(204)
  async remove(@Req() req: Request, @Param('email') email: string) {
    await this.grants.remove(req.user!.id, decodeURIComponent(email));
  }
}
