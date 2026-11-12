/**
 * Prisma adapter of the conversation media registry (unit 9). The tenant is
 * always the CLS tenant (bot guard or staff guards). `insert` is one statement
 * with `ON CONFLICT … DO NOTHING`, so a retry or a race never raises: `false`
 * means "this key already has a row".
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type {
  ConversationMediaStore,
  MediaRow,
} from '../application/conversation-media.service';

const SELECT = {
  id: true,
  storageKey: true,
  mimeType: true,
  sizeBytes: true,
  sha256: true,
  purgedAt: true,
} as const;

@Injectable()
export class PrismaConversationMediaStore implements ConversationMediaStore {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  tenantId(): string {
    return this.tenantPrisma.getTenantId();
  }

  findByKey(idempotencyKey: string): Promise<MediaRow | null> {
    return this.tenantPrisma.getClient().conversationMedia.findFirst({
      where: { tenantId: this.tenantId(), idempotencyKey },
      select: SELECT,
    });
  }

  findById(id: string): Promise<MediaRow | null> {
    return this.tenantPrisma.getClient().conversationMedia.findFirst({
      where: { id, tenantId: this.tenantId() },
      select: SELECT,
    });
  }

  /**
   * S2: the durable record that an object is about to be written. Committed on
   * its own BEFORE the upload, so a crash at any later point leaves a row the
   * retention sweep can act on. Due in an hour: by then the upload either
   * finished (a media row exists) or never will.
   */
  async recordIntent(row: { id: string; storageKey: string }): Promise<void> {
    await this.tenantPrisma.getClient().$executeRaw(Prisma.sql`
      INSERT INTO "conversation_media_intents"
        ("id", "tenantId", "storageKey", "reason", "createdAt", "dueAt")
      VALUES (${row.id}, ${this.tenantId()}, ${row.storageKey}, 'UPLOAD', now(),
              now() + interval '1 hour')
      ON CONFLICT ("id") DO NOTHING`);
  }

  /** The object is owned by a media row, or it is gone: the intent is done. */
  async dropIntent(id: string): Promise<void> {
    await this.tenantPrisma.getClient().$executeRaw(Prisma.sql`
      DELETE FROM "conversation_media_intents"
      WHERE "id" = ${id} AND "tenantId" = ${this.tenantId()}`);
  }

  async insert(row: {
    id: string;
    storageKey: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    idempotencyKey: string;
  }): Promise<boolean> {
    const inserted = await this.tenantPrisma.getClient().$queryRaw<
      Array<{ id: string }>
    >(Prisma.sql`
      INSERT INTO "conversation_media"
        ("id", "tenantId", "storageKey", "mimeType", "sizeBytes", "sha256",
         "idempotencyKey", "createdAt", "purgeAfter")
      VALUES (${row.id}, ${this.tenantId()}, ${row.storageKey}, ${row.mimeType},
              ${row.sizeBytes}, ${row.sha256}, ${row.idempotencyKey}, now(),
              now() + interval '12 months')
      ON CONFLICT ("tenantId", "idempotencyKey") DO NOTHING
      RETURNING "id"`);
    return inserted.length > 0;
  }
}
