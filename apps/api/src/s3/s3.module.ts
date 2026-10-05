import { S3Client } from '@aws-sdk/client-s3';
import { Global, Module } from '@nestjs/common';
import { CONFIG, type Config } from '../config/config';

export const S3 = Symbol('S3');

@Global()
@Module({
  providers: [
    {
      provide: S3,
      inject: [CONFIG],
      useFactory: (config: Config) =>
        new S3Client({
          endpoint: config.S3_ENDPOINT,
          region: 'us-east-1',
          forcePathStyle: true,
          credentials: { accessKeyId: config.S3_ACCESS_KEY, secretAccessKey: config.S3_SECRET_KEY },
        }),
    },
  ],
  exports: [S3],
})
export class S3Module {}
