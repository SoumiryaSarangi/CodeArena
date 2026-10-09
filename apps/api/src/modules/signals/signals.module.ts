import { Module } from '@nestjs/common';
import { SignalsController } from './signals.controller';
import { SignalsService } from './signals.service';

// IN-01: advisory editor signals during contests, and their 30-day retention.
@Module({ controllers: [SignalsController], providers: [SignalsService] })
export class SignalsModule {}
