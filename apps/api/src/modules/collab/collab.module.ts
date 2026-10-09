import { Module } from '@nestjs/common';
import { CollabTokenGuard } from '../plag/service-token.guard';
import { RealtimeModule } from '../realtime/realtime.module';
import { CollabController } from './collab.controller';
import { CollabService } from './collab.service';

// CP-01: the API side of the collab server's authentication.
@Module({
  imports: [RealtimeModule],
  controllers: [CollabController],
  providers: [CollabService, CollabTokenGuard],
})
export class CollabModule {}
