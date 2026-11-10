/**
 * Prisma adapter of `ChatbotRequestCommandStore` (§6.5). The tenant always
 * comes from CLS; every statement runs on the ambient transaction opened by
 * `transaction()`.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type {
  ChatbotRequestEventDraft,
  ChatbotRequestPatch,
  StaffActor,
} from '../domain/chatbot-request.commands';
import type {
  ChatbotRequestCommandStore,
  ChatbotRequestRow,
  ChatbotRequestView,
} from '../application/chatbot-request-commands.service';
import { refreshCustomerGroup } from './chatbot-request-writes';

@Injectable()
export class PrismaChatbotRequestCommandStore implements ChatbotRequestCommandStore {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private get tx() {
    return this.tenantPrisma.getClient();
  }

  private get tenantId() {
    return this.tenantPrisma.getTenantId();
  }

  transaction<T>(work: () => Promise<T>): Promise<T> {
    return this.tenantPrisma.runInTransaction(work);
  }

  /** Serializes retries of one key, so a concurrent retry replays (§12.12). */
  async lockIdempotencyKey(actorId: string, key: string): Promise<void> {
    // Prisma cannot decode `void`; the cast keeps the transaction-scoped lock.
    await this.tx.$queryRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtext(${this.tenantId}), hashtext(${`${actorId}:${key}`}))::text`,
    );
  }

  findReceipt(actorId: string, idempotencyKey: string) {
    return this.tx.staffCommandReceipt.findFirst({
      where: { tenantId: this.tenantId, actorId, idempotencyKey },
      select: { commandHash: true, responseSnapshot: true },
    });
  }

  async saveReceipt(
    actorId: string,
    idempotencyKey: string,
    commandHash: string,
    response: ChatbotRequestView,
  ): Promise<void> {
    await this.tx.staffCommandReceipt.create({
      data: {
        tenantId: this.tenantId,
        actorId,
        idempotencyKey,
        commandHash,
        // SAFETY: the view holds only strings, numbers and nulls.
        responseSnapshot: response as unknown as Prisma.InputJsonObject,
      },
    });
  }

  async findActor(userId: string): Promise<StaffActor | null> {
    const user = await this.tx.user.findUnique({
      where: { id: userId },
      select: { name: true },
    });
    return user ? { userId, displayName: user.name } : null;
  }

  /** CASL `manage`/`all` grants count too, as in `CaslAbilityFactory`. */
  async findAssignableUser(userId: string): Promise<StaffActor | null> {
    const membership = await this.tx.tenantMembership.findFirst({
      where: {
        userId,
        tenantId: this.tenantId,
        user: { isActive: true },
        role: {
          permissions: {
            some: {
              permission: {
                action: { in: ['update', 'manage'] },
                subject: { in: ['ChatbotRequest', 'all'] },
              },
            },
          },
        },
      },
      select: { user: { select: { name: true } } },
    });
    return membership ? { userId, displayName: membership.user.name } : null;
  }

  async lockRequest(id: string): Promise<ChatbotRequestRow | null> {
    const rows = await this.tx.$queryRaw<ChatbotRequestRow[]>(Prisma.sql`
      SELECT "id", "folio", "kind"::text AS "kind", "subtype"::text AS "subtype",
             "status"::text AS "status", "version", "customerKey",
             "assigneeUserId", "assigneeDisplayName", "claimedAt", "overdueAt",
             "closedAt"
      FROM "chatbot_requests"
      WHERE "tenantId" = ${this.tenantId} AND "id" = ${id}
      FOR UPDATE`);
    return rows[0] ?? null;
  }

  async apply(
    row: ChatbotRequestRow,
    patch: ChatbotRequestPatch,
    event: ChatbotRequestEventDraft,
  ): Promise<void> {
    const { tx, tenantId } = this;
    // The row is locked, so the CAS cannot lose; a miss is a broken invariant.
    const { count } = await tx.chatbotRequest.updateMany({
      where: { tenantId, id: row.id, version: row.version },
      data: patch,
    });
    if (count !== 1) throw new Error('chatbot request CAS missed a locked row');
    await tx.chatbotRequestEvent.create({
      data: {
        ...event,
        tenantId,
        requestId: row.id,
        data: event.data as Prisma.InputJsonObject,
      },
    });
    await refreshCustomerGroup(tx, tenantId, row.customerKey);
  }
}
