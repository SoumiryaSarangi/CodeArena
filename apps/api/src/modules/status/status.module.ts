import { Module } from '@nestjs/common';
import { SubmissionsModule } from '../submissions/submissions.module';
import { StatusController } from './status.controller';
import { StatusService } from './status.service';

// O-02: the public status page's data.
@Module({
  imports: [SubmissionsModule],
  controllers: [StatusController],
  providers: [StatusService],
})
export class StatusModule {}
