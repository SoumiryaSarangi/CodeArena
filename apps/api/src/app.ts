import 'reflect-metadata';
import type { DynamicModule, INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { json } from 'express';
import { AppModule } from './app.module';
import { requestId } from './common/request-id';
import { type Config, loadConfig } from './config/config';
import { createLogger } from './telemetry/logger';
import { httpTelemetry } from './telemetry/http-telemetry';

/** `extra` lets tests mount throwaway routes; production passes nothing. */
export async function createApp(
  config: Config = loadConfig(),
  extra: NonNullable<DynamicModule['imports']> = [],
): Promise<INestApplication> {
  const app = await NestFactory.create(AppModule.forRoot(config, extra), {
    logger: false,
    bodyParser: false,
  });
  app.getHttpAdapter().getInstance().disable('x-powered-by');
  app.setGlobalPrefix('api');
  app.use(requestId);
  app.use(httpTelemetry(createLogger(config)));
  // Largest legitimate body is a run input of 1 MB plus a 64 KB source (SRS §3.2.3).
  app.use(json({ limit: '1.5mb' }));
  app.enableShutdownHooks();

  if (config.NODE_ENV === 'development') {
    const doc = SwaggerModule.createDocument(
      app,
      new DocumentBuilder().setTitle('CodeArena API').setVersion('0.0.0').addBearerAuth().build(),
    );
    SwaggerModule.setup('docs', app, doc);
  }
  return app;
}
