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
import { lockZipCode } from '../../delivery-zones/infrastructure/delivery-zone-persistence';
import {
  applyRequestPatch,
  findZoneOf,
  lockOpenWrapping,
  lockRequestRow,
  readZoneImpact,
  refreshCustomerGroup,
  refreshCustomerGroups,
} from './chatbot-request-writes';

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

  /**
   * Serializes retries of one key, so a concurrent retry replays (§12.12).
   * One bigint key (a different advisory key space from the cash
   * `(int, int)` form) over a text carrying the `chatbot-staff:` namespace.
   */
  async lockIdempotencyKey(actorId: string, key: string): Promise<void> {
    const namespaced = `chatbot-staff:${this.tenantId}:${actorId}:${key}`;
    // Prisma cannot decode `void`; the cast keeps the transaction-scoped lock.
    await this.tx.$queryRaw(
      Prisma.sql`SELECT pg_advisory_xact_lock(hashtextextended(${namespaced}, 0))::text`,
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

  /**
   * An active member whose role grants both `read` and `update` on
   * `ChatbotRequest` (§2.5: update needs read). As in `CaslAbilityFactory`,
   * `manage` and subject `all` grants count too.
   */
  async findAssignableUser(userId: string): Promise<StaffActor | null> {
    const grants = (action: string) => ({
      permissions: {
        some: {
          permission: {
            action: { in: [action, 'manage'] },
            subject: { in: ['ChatbotRequest', 'all'] },
          },
        },
      },
    });
    const membership = await this.tx.tenantMembership.findFirst({
      where: {
        userId,
        tenantId: this.tenantId,
        user: { isActive: true },
        // A user can hold several memberships; each grant may come from any.
        AND: [{ role: grants('read') }, { role: grants('update') }],
      },
      select: { user: { select: { name: true } } },
    });
    return membership ? { userId, displayName: membership.user.name } : null;
  }

  lockRequest(id: string): Promise<ChatbotRequestRow | null> {
    return lockRequestRow(this.tx, this.tenantId, id);
  }

  async apply(
    row: ChatbotRequestRow,
    patch: ChatbotRequestPatch,
    event: ChatbotRequestEventDraft,
  ): Promise<void> {
    await this.applyPatch(row, patch, event);
    await refreshCustomerGroup(this.tx, this.tenantId, row.customerKey);
  }

  applyPatch(
    row: ChatbotRequestRow,
    patch: ChatbotRequestPatch,
    event: ChatbotRequestEventDraft,
  ): Promise<void> {
    return applyRequestPatch(this.tx, this.tenantId, row, patch, event);
  }

  refreshGroups(customerKeys: string[]): Promise<void> {
    return refreshCustomerGroups(this.tx, this.tenantId, customerKeys);
  }

  async lockZoneOf(requestId: string): Promise<void> {
    const zone = await findZoneOf(this.tx, this.tenantId, requestId);
    if (zone) await lockZipCode(this.tx, this.tenantId, zone.zipCode);
  }

  async lockZoneSet(row: ChatbotRequestRow) {
    const zone = await findZoneOf(this.tx, this.tenantId, row.id);
    if (!zone) return null;
    const siblings = await lockOpenWrapping(this.tx, this.tenantId, {
      validationId: zone.validationId,
    });
    const impact = await readZoneImpact(
      this.tx,
      this.tenantId,
      zone.validationId,
    );
    return { siblings, impact };
  }

  async readZoneImpact(requestId: string) {
    const exists = await this.tx.chatbotRequest.count({
      where: { tenantId: this.tenantId, id: requestId },
    });
    if (exists === 0) return { found: false, impact: null };
    const zone = await findZoneOf(this.tx, this.tenantId, requestId);
    return {
      found: true,
      impact: zone
        ? await readZoneImpact(this.tx, this.tenantId, zone.validationId)
        : null,
    };
  }
}
