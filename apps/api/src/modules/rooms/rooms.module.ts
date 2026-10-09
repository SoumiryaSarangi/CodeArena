import { Module } from '@nestjs/common';
import { SubmissionsModule } from '../submissions/submissions.module';
import { RoomNotesService } from './room-notes.service';
import { RoomPlaybackService } from './room-playback.service';
import { RoomRunsService } from './room-runs.service';
import { RoomsController } from './rooms.controller';
import { RoomsRetention } from './rooms-retention.service';
import { RoomsService } from './rooms.service';

// CP-02: interview rooms, invites and membership. CP-04: running code from a room.
@Module({
  imports: [SubmissionsModule],
  controllers: [RoomsController],
  providers: [RoomsService, RoomRunsService, RoomNotesService, RoomPlaybackService, RoomsRetention],
  exports: [RoomsService, RoomRunsService, RoomNotesService, RoomPlaybackService],
})
export class RoomsModule {}
