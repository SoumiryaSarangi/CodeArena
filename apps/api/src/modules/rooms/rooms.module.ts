import { Module } from '@nestjs/common';
import { SubmissionsModule } from '../submissions/submissions.module';
import { RoomNotesService } from './room-notes.service';
import { RoomRunsService } from './room-runs.service';
import { RoomsController } from './rooms.controller';
import { RoomsService } from './rooms.service';

// CP-02: interview rooms, invites and membership. CP-04: running code from a room.
@Module({
  imports: [SubmissionsModule],
  controllers: [RoomsController],
  providers: [RoomsService, RoomRunsService, RoomNotesService],
  exports: [RoomsService, RoomRunsService, RoomNotesService],
})
export class RoomsModule {}
