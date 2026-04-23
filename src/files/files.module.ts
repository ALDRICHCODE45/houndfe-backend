/**
 * FilesModule - NestJS module for the Files bounded context.
 *
 * Registers:
 * - S3Client configured for DigitalOcean Spaces
 * - SpacesStorageAdapter as IStoragePort implementation
 * - PrismaFileRepository as IFileRepository implementation
 * - FilesService for file orchestration
 * - FilesController for HTTP endpoints
 *
 * Exports FilesService so other modules (Products) can use it.
 */
import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { S3Client } from '@aws-sdk/client-s3';
import { AuthModule } from '../auth/auth.module';
import { FilesController } from './files.controller';
import { FilesService } from './files.service';
import { STORAGE_PORT } from './domain/storage.port';
import { FILE_REPOSITORY } from './domain/file.repository';
import { SpacesStorageAdapter } from './infrastructure/spaces-storage.adapter';
import { PrismaFileRepository } from './infrastructure/prisma-file.repository';

@Module({
  imports: [AuthModule],
  controllers: [FilesController],
  providers: [
    FilesService,
    {
      provide: FILE_REPOSITORY,
      useClass: PrismaFileRepository,
    },
    {
      provide: 'S3_CLIENT',
      useFactory: (configService: ConfigService) => {
        return new S3Client({
          endpoint: configService.getOrThrow<string>('SPACES_ENDPOINT'),
          region: configService.getOrThrow<string>('SPACES_REGION'),
          credentials: {
            accessKeyId: configService.getOrThrow<string>(
              'SPACES_ACCESS_KEY_ID',
            ),
            secretAccessKey: configService.getOrThrow<string>(
              'SPACES_SECRET_ACCESS_KEY',
            ),
          },
          forcePathStyle: false,
        });
      },
      inject: [ConfigService],
    },
    {
      provide: STORAGE_PORT,
      useFactory: (s3Client: S3Client, configService: ConfigService) => {
        const bucket = configService.getOrThrow<string>('SPACES_BUCKET');
        const publicBaseUrl = configService.getOrThrow<string>(
          'SPACES_PUBLIC_BASE_URL',
        );
        return new SpacesStorageAdapter(s3Client, bucket, publicBaseUrl);
      },
      inject: ['S3_CLIENT', ConfigService],
    },
  ],
  exports: [FilesService],
})
export class FilesModule {}
