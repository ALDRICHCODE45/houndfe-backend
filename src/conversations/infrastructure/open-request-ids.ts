/**
 * The open requests of one chat (by `conversationRef`), oldest first: the
 * requests whose inbox rows a conversation event touches. Shared by the mirror
 * (a message arrived) and the staff read (someone opened the chat).
 */
import { Prisma } from '@prisma/client';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';

/** The chat's open requests that get a realtime event (the open limit is 20). */
export const OPEN_REQUESTS_PER_CHAT = 20;

type Db = ReturnType<TenantPrismaService['getClient']>;

export async function openRequestIds(
  db: Db,
  tenantId: string,
  conversationRef: string,
): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    SELECT "id" FROM "chatbot_requests"
    WHERE "tenantId" = ${tenantId} AND "conversationRef" = ${conversationRef}
      AND "status" IN ('NEW', 'IN_PROGRESS')
    ORDER BY "createdAt", "id" LIMIT ${OPEN_REQUESTS_PER_CHAT}`);
  return rows.map((r) => r.id);
}
