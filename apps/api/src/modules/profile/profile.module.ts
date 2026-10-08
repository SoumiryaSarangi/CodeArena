import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';

// UI-05: the data behind the profile and home screens.
@Module({ controllers: [ProfileController], providers: [ProfileService] })
export class ProfileModule {}
