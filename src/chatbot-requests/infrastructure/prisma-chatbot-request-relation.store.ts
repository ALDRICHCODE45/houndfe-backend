/**
 * Prisma adapter of `ChatbotRequestRelationStore` (unit 4, slice 4b). It runs
 * on the ambient transaction the command store opened; the tenant comes from
 * CLS and every statement names it.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { StaffActor } from '../domain/chatbot-request.commands';
import type { ChatbotRequestEventDraft } from '../domain/chatbot-request.commands';
import type {
  ChatbotRequestRelationStore,
  LinkRow,
} from '../application/chatbot-request-relations.service';
import type { ChatbotRequestRow } from '../application/chatbot-request-commands.service';
import { lockZipCode } from '../../delivery-zones/infrastructure/delivery-zone-persistence';
import { lockRequestRows, peekRequestRows } from './chatbot-request-writes';

@Injectable()
export class PrismaChatbotRequestRelationStore implements ChatbotRequestRelationStore {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private get tx() {
    return this.tenantPrisma.getClient();
  }

  private get tenantId() {
    return this.tenantPrisma.getTenantId();
  }

  peekRequests(ids: string[]): Promise<ChatbotRequestRow[]> {
    return peekRequestRows(this.tx, this.tenantId, ids);
  }

  lockRequests(ids: string[]): Promise<ChatbotRequestRow[]> {
    return lockRequestRows(this.tx, this.tenantId, ids);
  }

  async recordEvent(
    requestId: string,
    event: ChatbotRequestEventDraft,
  ): Promise<void> {
    await this.tx.chatbotRequestEvent.create({
      data: {
        ...event,
        tenantId: this.tenantId,
        requestId,
        data: event.data as Prisma.InputJsonObject,
      },
    });
  }

  /** Distinct postal codes, sorted, so two linkers always lock in one order. */
  async lockZonesOfKey(customerKey: string): Promise<void> {
    const zips = await this.tx.$queryRaw<{ zipCode: string }[]>(Prisma.sql`
      SELECT DISTINCT dzr."zipCode"
      FROM "chatbot_requests" cr
      JOIN "delivery_zone_requests" dzr ON dzr."id" = cr."deliveryZoneRequestId"
      WHERE cr."tenantId" = ${this.tenantId} AND cr."customerKey" = ${customerKey}
        AND dzr."tenantId" = ${this.tenantId}
      ORDER BY dzr."zipCode"`);
    for (const { zipCode } of zips) {
      await lockZipCode(this.tx, this.tenantId, zipCode);
    }
  }

  lockLinkSet(customerKey: string, anchorId: string): Promise<LinkRow[]> {
    return this.tx.$queryRaw<LinkRow[]>(Prisma.sql`
      SELECT cr."id", cr."folio", cr."kind"::text AS "kind",
             cr."subtype"::text AS "subtype", cr."status"::text AS "status",
             cr."version", cr."customerKey", cr."customerId",
             cr."assigneeUserId", cr."assigneeDisplayName", cr."claimedAt",
             cr."overdueAt", cr."closedAt", cr."humanDecisionId",
             cr."deliveryZoneRequestId", cr."receiptEvidenceId"
      FROM "chatbot_requests" cr
      WHERE cr."tenantId" = ${this.tenantId}
        AND ((cr."customerKey" = ${customerKey} AND cr."customerId" IS NULL)
             OR cr."id" = ${anchorId})
      ORDER BY cr."id"
      FOR UPDATE OF cr`);
  }

  findCustomer(customerId: string) {
    return this.tx.customer.findFirst({
      where: { tenantId: this.tenantId, id: customerId },
      select: { id: true, phoneCountryCode: true, phone: true },
    });
  }

  async linkSiblings(
    siblings: LinkRow[],
    customerId: string,
    actor: StaffActor,
    viaRequestId: string,
  ): Promise<void> {
    if (siblings.length === 0) return;
    // Rows are locked; only the customer columns change, so the version stays
    // and a concurrent claim of a sibling is never invalidated.
    await this.tx.chatbotRequest.updateMany({
      where: {
        tenantId: this.tenantId,
        id: { in: siblings.map((row) => row.id) },
      },
      data: { customerId, ambiguousCustomer: false },
    });
    await this.tx.chatbotRequestEvent.createMany({
      data: siblings.map((row) => ({
        tenantId: this.tenantId,
        requestId: row.id,
        type: 'CUSTOMER_LINKED' as const,
        actorKind: 'USER' as const,
        actorId: actor.userId,
        actorDisplayName: actor.displayName,
        fromStatus: row.status,
        toStatus: row.status,
        version: row.version,
        data: { customerId, viaRequestId },
      })),
    });
  }
}
