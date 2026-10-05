import { Controller, Get, Module } from '@nestjs/common';
import type { Health } from '@codearena/contracts';

@Controller()
export class HealthController {
  @Get('healthz')
  health(): Health {
    return { status: 'ok', service: 'api' };
  }
}

@Module({ controllers: [HealthController] })
export class AppModule {}
