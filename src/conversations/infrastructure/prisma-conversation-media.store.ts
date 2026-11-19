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
  filename: true,
  requestId: true,
  uploadedByUserId: true,
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

  async findStaffAttached(id: string): Promise<MediaRow | null> {
    const [row] = await this.tenantPrisma.getClient().$queryRaw<MediaRow[]>(
      Prisma.sql`
      SELECT m."id", m."storageKey", m."mimeType", m."sizeBytes", m."sha256",
             m."purgedAt", m."filename", m."requestId", m."uploadedByUserId"
      FROM "conversation_media" m
      WHERE m."tenantId" = ${this.tenantId()} AND m."id" = ${id}
        AND EXISTS (
          SELECT 1 FROM "conversation_messages" x
          WHERE x."tenantId" = m."tenantId" AND x."mediaId" = m."id"
            AND x."author" = 'STAFF' AND x."direction" = 'OUT')`,
    );
    return row ?? null;
  }

  async attendeeSeesMedia(id: string, userId: string): Promise<boolean> {
    const rows = await this.tenantPrisma.getClient().$queryRaw<unknown[]>(
      Prisma.sql`
      SELECT 1
      FROM "conversation_messages" x
      JOIN "chatbot_conversations" c
        ON c."tenantId" = x."tenantId" AND c."id" = x."conversationId"
      JOIN "chatbot_requests" r
        ON r."tenantId" = c."tenantId" AND r."conversationRef" = c."conversationRef"
       AND r."assigneeUserId" = ${userId} AND r."status"::text = 'IN_PROGRESS'
      JOIN LATERAL (
        SELECT s."startSeq" FROM "chatbot_live_sessions" s
        WHERE s."tenantId" = r."tenantId" AND s."requestId" = r."id"
        ORDER BY s."epoch" DESC LIMIT 1) s ON true
      WHERE x."tenantId" = ${this.tenantId()} AND x."mediaId" = ${id}
        AND x."seq" >= s."startSeq"
      LIMIT 1`,
    );
    return rows.length > 0;
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
    requestId?: string;
    uploadedByUserId?: string;
    filename?: string;
  }): Promise<boolean> {
    const inserted = await this.tenantPrisma.getClient().$queryRaw<
      Array<{ id: string }>
    >(Prisma.sql`
      INSERT INTO "conversation_media"
        ("id", "tenantId", "storageKey", "mimeType", "sizeBytes", "sha256",
         "idempotencyKey", "createdAt", "purgeAfter", "requestId",
         "uploadedByUserId", "filename")
      VALUES (${row.id}, ${this.tenantId()}, ${row.storageKey}, ${row.mimeType},
              ${row.sizeBytes}, ${row.sha256}, ${row.idempotencyKey}, now(),
              now() + interval '12 months', ${row.requestId ?? null},
              ${row.uploadedByUserId ?? null}, ${row.filename ?? null})
      ON CONFLICT ("tenantId", "idempotencyKey") DO NOTHING
      RETURNING "id"`);
    return inserted.length > 0;
  }
}
