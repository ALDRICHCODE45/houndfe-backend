/**
 * Prisma adapter of `ChatbotRequestCommandStore` (§6.5). The tenant always
 * comes from CLS; every statement runs on the ambient transaction opened by
 * `transaction()`.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { ClosedCause } from '../../notifications/domain/chatbot-request-notice';
import { actorDisplayName } from '../domain/actor-display-name';
import type {
  ChatbotRequestEventDraft,
  ChatbotRequestPatch,
  StaffActor,
  StaffCancelReason,
} from '../domain/chatbot-request.commands';
import type {
  ChatbotRequestCommandStore,
  ChatbotRequestRow,
  ChatbotRequestView,
} from '../application/chatbot-request-commands.service';
import {
  enqueueClosedNotice,
  enqueueNotice,
} from '../../notifications/infrastructure/chatbot-request-notice.writer';
import {
  enqueueAnswered,
  enqueueCancelled,
  enqueueClarificationAnswer,
} from './chatbot-feed-writes';
import { assignableUserWhere } from './assignable-users';
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

/** Why a staff command closed a request (the wording of the notice). */
function closedCause(
  status: 'RESOLVED' | 'CANCELLED',
  event: ChatbotRequestEventDraft,
): ClosedCause {
  if (event.type === 'MERGED') return 'MERGED';
  if (status === 'CANCELLED') return 'CANCELLED_BY_OTHER';
  return event.data.action === 'SIBLING_RESOLVED' ||
    event.data.viaRequestId !== undefined
    ? 'SIBLING_RESOLVED'
    : 'RESOLVED_BY_OTHER';
}

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
      select: { name: true, email: true },
    });
    return user ? { userId, displayName: actorDisplayName(user) } : null;
  }

  /** Same rule as `GET /chatbot-requests/assignable-users` (`assignable-users.ts`). */
  async findAssignableUser(userId: string): Promise<StaffActor | null> {
    const user = await this.tx.user.findFirst({
      where: assignableUserWhere(this.tenantId, userId),
      select: { name: true, email: true },
    });
    return user ? { userId, displayName: actorDisplayName(user) } : null;
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
    // Unit 6: "reassigned to me" goes to the new assignee, never to the person
    // who reassigned (the writer drops a notice addressed to its actor).
    if (event.type === 'REASSIGNED' && patch.assigneeUserId) {
      await enqueueNotice(this.tx, this.tenantId, {
        type: 'REQUEST_REASSIGNED',
        requestId: row.id,
        folio: row.folio,
        subtype: row.subtype,
        dedupKey: `reassigned:${row.id}:${patch.version}`,
        recipientUserId: patch.assigneeUserId,
        actorUserId: event.actorId,
      });
    }
    await refreshCustomerGroup(this.tx, this.tenantId, row.customerKey);
  }

  async applyPatch(
    row: ChatbotRequestRow,
    patch: ChatbotRequestPatch,
    event: ChatbotRequestEventDraft,
  ): Promise<void> {
    await applyRequestPatch(this.tx, this.tenantId, row, patch, event);
    // Unit 6 (§5.1): a request that closes under the person attending it, by
    // someone else's hand, tells them. One hook for every staff close: the
    // resolve, its zone siblings and the staff cancel all come through here.
    if (patch.status === 'RESOLVED' || patch.status === 'CANCELLED') {
      await enqueueClosedNotice(
        this.tx,
        this.tenantId,
        row,
        closedCause(patch.status, event),
        event.actorId,
      );
    }
  }

  refreshGroups(customerKeys: string[]): Promise<void> {
    return refreshCustomerGroups(this.tx, this.tenantId, customerKeys);
  }

  enqueueAnswered(requestIds: string[]): Promise<void> {
    return enqueueAnswered(this.tx, this.tenantId, requestIds);
  }

  enqueueCancelled(
    requestId: string,
    reason: StaffCancelReason,
    customerNote?: string,
  ): Promise<void> {
    return enqueueCancelled(
      this.tx,
      this.tenantId,
      requestId,
      reason,
      customerNote,
    );
  }

  enqueueClarificationAnswer(
    requestId: string,
    replyId: string,
    text: string,
  ): Promise<void> {
    return enqueueClarificationAnswer(
      this.tx,
      this.tenantId,
      requestId,
      replyId,
      text,
    );
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
