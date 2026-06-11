import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';

export const BOT_AUDIT_LOG_REPOSITORY = Symbol('BOT_AUDIT_LOG_REPOSITORY');

export type BotAuditLogEntry = {
  tenantId: string;
  credentialId: string;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  metadata?: Prisma.JsonObject | null;
};

export interface IBotAuditLogRepository {
  append(entry: BotAuditLogEntry): Promise<void>;
}

@Injectable()
export class PrismaBotAuditLogRepository implements IBotAuditLogRepository {
  constructor(private readonly prisma: PrismaService) {}

  async append(entry: BotAuditLogEntry): Promise<void> {
    await this.prisma.botAuditLog.create({
      data: {
        tenantId: entry.tenantId,
        credentialId: entry.credentialId,
        action: entry.action,
        resourceType: entry.resourceType,
        resourceId: entry.resourceId ?? null,
        metadata: entry.metadata ?? undefined,
      },
    });
  }
}
