import { Module } from '@nestjs/common';
import { PlagAdminController, PlagClusterController, PlagJobController } from './plag.controller';
import { PlagService } from './plag.service';
import { ServiceTokenGuard } from './service-token.guard';

// PL-05: the API side of the plagiarism job (runs, claim, results).
@Module({
  controllers: [PlagAdminController, PlagClusterController, PlagJobController],
  providers: [PlagService, ServiceTokenGuard],
})
export class PlagModule {}
