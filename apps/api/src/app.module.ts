import { type DynamicModule, Global, Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { ProblemFilter } from './common/problem.filter';
import { CONFIG, type Config } from './config/config';
import { DbModule } from './db/db.module';
import { HealthModule } from './health/health.module';
import { AdminModule } from './modules/admin/admin.module';
import { AiModule } from './modules/ai/ai.module';
import { AuthModule } from './modules/auth/auth.module';
import { ContestsModule } from './modules/contests/contests.module';
import { OpsModule } from './modules/ops/ops.module';
import { RatingsModule } from './modules/ratings/ratings.module';
import { StatusModule } from './modules/status/status.module';
import { ProfileModule } from './modules/profile/profile.module';
import { ProblemsModule } from './modules/problems/problems.module';
import { RealtimeModule } from './modules/realtime/realtime.module';
import { RoomsModule } from './modules/rooms/rooms.module';
import { SubmissionsModule } from './modules/submissions/submissions.module';
import { UsersModule } from './modules/users/users.module';
import { RateLimitGuard } from './rate-limit/rate-limit';
import { AuthGuard, CsrfGuard, RequireHandleGuard, RolesGuard } from './modules/auth/guards';
import { RedisModule } from './redis/redis.module';
import { S3Module } from './s3/s3.module';
import { createLogger, LOGGER } from './telemetry/logger';

@Global()
@Module({})
class CoreModule {
  static forRoot(config: Config): DynamicModule {
    return {
      module: CoreModule,
      providers: [
        { provide: CONFIG, useValue: config },
        { provide: LOGGER, useValue: createLogger(config) },
      ],
      exports: [CONFIG, LOGGER],
    };
  }
}

@Module({})
export class AppModule {
  static forRoot(config: Config, extra: NonNullable<DynamicModule['imports']> = []): DynamicModule {
    return {
      module: AppModule,
      imports: [
        CoreModule.forRoot(config),
        DbModule,
        RedisModule,
        S3Module,
        HealthModule,
        AuthModule,
        UsersModule,
        ProblemsModule,
        SubmissionsModule,
        ContestsModule,
        OpsModule,
        RatingsModule,
        StatusModule,
        ProfileModule,
        RealtimeModule,
        AdminModule,
        AiModule,
        RoomsModule,
        ...extra,
      ],
      providers: [
        { provide: APP_FILTER, useClass: ProblemFilter },
        // Order matters: who you are → CSRF → role → handle → rate limit (keyed by user when known).
        { provide: APP_GUARD, useClass: AuthGuard },
        { provide: APP_GUARD, useClass: CsrfGuard },
        { provide: APP_GUARD, useClass: RolesGuard },
        { provide: APP_GUARD, useClass: RequireHandleGuard },
        { provide: APP_GUARD, useClass: RateLimitGuard },
      ],
    };
  }
}
