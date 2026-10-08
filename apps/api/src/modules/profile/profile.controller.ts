import { Controller, Get, Inject, Param, Req } from '@nestjs/common';
import type { Request } from 'express';
import { Public } from '../auth/guards';
import { ProfileService } from './profile.service';

@Controller()
export class ProfileController {
  constructor(@Inject(ProfileService) private readonly profiles: ProfileService) {}

  /** A profile is public: handle, rating, solved counts, a year of activity. No e-mail or name. */
  @Public()
  @Get('users/:handle/profile')
  profile(@Param('handle') handle: string) {
    return this.profiles.profile(handle);
  }

  @Get('me/home')
  home(@Req() req: Request) {
    return this.profiles.home(req.user!.id);
  }
}
