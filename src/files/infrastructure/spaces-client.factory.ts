import { S3Client } from '@aws-sdk/client-s3';
import type { ConfigService } from '@nestjs/config';

/** Single source of the DigitalOcean Spaces client configuration (SPACES_*). */
export function createSpacesClient(configService: ConfigService): S3Client {
  return new S3Client({
    endpoint: configService.getOrThrow<string>('SPACES_ENDPOINT'),
    region: configService.getOrThrow<string>('SPACES_REGION'),
    credentials: {
      accessKeyId: configService.getOrThrow<string>('SPACES_ACCESS_KEY_ID'),
      secretAccessKey: configService.getOrThrow<string>(
        'SPACES_SECRET_ACCESS_KEY',
      ),
    },
    forcePathStyle: false,
  });
}
