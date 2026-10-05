import { Module } from '@nestjs/common';
import { CONFIG, type Config } from '../../config/config';
import { LOGGER } from '../../telemetry/logger';
import { UsersModule } from '../users/users.module';
import { AuthController } from './auth.controller';
import { ACCESS_TOKENS, AccessTokens } from './keys';
import { OAuthController } from './oauth.controller';
import { github, google, OAUTH_PROVIDERS, type OAuthProviders } from './oauth/providers';
import { TokensService } from './tokens.service';
import type { Logger } from 'pino';

@Module({
  imports: [UsersModule],
  controllers: [OAuthController, AuthController],
  providers: [
    TokensService,
    {
      provide: ACCESS_TOKENS,
      inject: [CONFIG, LOGGER],
      useFactory: (config: Config, log: Logger) => AccessTokens.create(config, log),
    },
    {
      provide: OAUTH_PROVIDERS,
      inject: [CONFIG],
      useFactory: (config: Config): OAuthProviders => ({
        google: google(config),
        github: github(config),
      }),
    },
  ],
  exports: [ACCESS_TOKENS, TokensService],
})
export class AuthModule {}
