/**
 * The one place that reads notifications for display (contract §5.2, S10): the
 * list route, `eventView` and the realtime reader all go through here, so the
 * rows (and so the views) are identical.
 *
 * Each statement LEFT JOINs the linked request to know whether it is still open
 * (`requestOpen`): one statement however many rows, never one per row. The
 * join is on `(tenantId, id)`, the request's unique key, and both sides name the
 * tenant explicitly (raw SQL is not scoped by the tenant client), so a notice
 * can never learn the status of another sucursal's request. `requestId` is a
 * plain column without a foreign key, so a purged or foreign id simply joins to
 * nothing (`requestStatus` null).
 */
import { Prisma, type PrismaClient } from '@prisma/client';
import type { NotificationViewRow } from '../domain/notification-view';

/** What the statements need: a tenant client, a transaction or the root one. */
export type NotificationRowsDb = Pick<PrismaClient, '$queryRaw'>;

const SELECT = Prisma.sql`
  SELECT n."id", n."userId", n."type", n."payload", n."requestId",
         n."createdAt", n."readAt", r."status"::text AS "requestStatus"
  FROM "notifications" n
  LEFT JOIN "chatbot_requests" r
    ON r."tenantId" = n."tenantId" AND r."id" = n."requestId"`;

export type NotificationRow = NotificationViewRow & { userId: string };

export interface ListNotificationRows {
  tenantId: string;
  userId: string;
  unreadOnly: boolean;
  /** Keyset position of the last row of the previous page. */
  after?: { createdAt: Date; id: string };
  take: number;
}

/** One person's notices, newest first (`createdAt desc, id desc`). */
export function listNotificationRows(
  db: NotificationRowsDb,
  query: ListNotificationRows,
): Promise<NotificationRow[]> {
  const unread = query.unreadOnly
    ? Prisma.sql`AND n."readAt" IS NULL`
    : Prisma.empty;
  const after = query.after
    ? Prisma.sql`AND (n."createdAt" < ${query.after.createdAt}
        OR (n."createdAt" = ${query.after.createdAt}
            AND n."id" < ${query.after.id}))`
    : Prisma.empty;
  return db.$queryRaw<NotificationRow[]>(Prisma.sql`
    ${SELECT}
    WHERE n."tenantId" = ${query.tenantId} AND n."userId" = ${query.userId}
      ${unread} ${after}
    ORDER BY n."createdAt" DESC, n."id" DESC
    LIMIT ${query.take}`);
}

/**
 * The wanted notices by id, each only if it belongs to one of `userIds` in the
 * tenant. The caller keeps the id → owner pairing (one id has one owner).
 */
export function findNotificationRows(
  db: NotificationRowsDb,
  query: { tenantId: string; userIds: string[]; ids: string[] },
): Promise<NotificationRow[]> {
  return db.$queryRaw<NotificationRow[]>(Prisma.sql`
    ${SELECT}
    WHERE n."tenantId" = ${query.tenantId}
      AND n."userId" IN (${Prisma.join(query.userIds)})
      AND n."id" IN (${Prisma.join(query.ids)})`);
}
