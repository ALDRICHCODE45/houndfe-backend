import type { PrismaClient } from '@prisma/client';
import { PrivateMediaAccess } from './application/private-media-access';
import { PrivateMediaService } from './application/private-media.service';
import { resolvePrivateMediaConfig } from './infrastructure/private-media-config';
import { PrismaPrivateMediaRepository } from './infrastructure/prisma-private-media.repository';
import { PrivateS3Storage } from './infrastructure/private-s3-storage';

/** Explicit internal composition only; no environment discovery or HTTP wiring. */
export function createPrivateMediaService(
  settings: unknown,
  prisma: Pick<
    PrismaClient,
    'user' | 'tenantMembership' | 'product' | '$queryRaw'
  >,
): PrivateMediaService | null {
  const config = resolvePrivateMediaConfig(settings);
  if (!config) return null;
  return new PrivateMediaService(
    new PrivateMediaAccess(prisma),
    new PrivateS3Storage(config),
    new PrismaPrivateMediaRepository(prisma),
    config,
  );
}
