/**
 * Prisma adapter of `BotIntakeStore` (unit 5). The tenant always comes from
 * CLS; every statement runs on the ambient transaction opened by
 * `transaction()` (or, for the two reads the wrapped path makes outside one,
 * on the tenant-scoped client).
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { CUSTOMER_REPLY_WINDOW_MS } from '../../delivery-zones/domain/delivery-zone.policy';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type {
  BotCancelResponse,
  BotCreateResponse,
  BotIntakeStore,
  DirectDraft,
  IntakeOutcome,
} from '../application/bot-request-intake.service';
import type { ChatbotRequestRow } from '../application/chatbot-request-commands.service';
import type { WrappedSubtype } from '../domain/bot-request-envelope';
import type {
  ChatbotRequestEventDraft,
  ChatbotRequestPatch,
} from '../domain/chatbot-request.commands';
import {
  assertIntakeLimits,
  findOpenDedup,
  insertRequestOnDedup,
  IntakeMergeSignal,
  lockBotKey,
  lockCustomerIntake,
  recordMerge,
  type OpenRequestRef,
} from './chatbot-request-intake-writes';
import { linkByPhone, WRAP_SOURCE } from './chatbot-request-wrapper';
import {
  allocateFolio,
  applyRequestPatch,
  assertTenantLinks,
  findZoneOf,
  lockRequestRow,
  refreshCustomerGroup,
} from './chatbot-request-writes';
import { lockZipCode } from '../../delivery-zones/infrastructure/delivery-zone-persistence';

/** `source` of the requests the bot creates itself (wrapper rows use `WRAP:`). */
export const BOT_REQUEST_SOURCE = 'houndfe-chatbot';

const WRAPPER_SOURCE: Record<WrappedSubtype, string> = {
  RESTOCK: WRAP_SOURCE.humanDecision,
  EXPIRATION: WRAP_SOURCE.humanDecision,
  DELIVERY_ZONE: WRAP_SOURCE.deliveryZoneRequest,
};

/** The phone a wrapped request's `customerKey` comes from at insert time. */
function insertPhone(
  envelope: DirectDraft['envelope'],
): { phoneCountryCode: string; phone: string } | null {
  if (envelope.subtype === 'DELIVERY_ZONE') {
    const { phoneCountryCode, phone } = envelope.detail;
    return typeof phoneCountryCode === 'string' && typeof phone === 'string'
      ? { phoneCountryCode, phone }
      : null;
  }
  return envelope.customer;
}

@Injectable()
export class PrismaBotIntakeStore implements BotIntakeStore {
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

  lockKey(kind: 'CREATE' | 'CANCEL', key: string): Promise<void> {
    return lockBotKey(this.tx, this.tenantId, kind, key);
  }

  findReceipt(kind: 'CREATE' | 'CANCEL', idempotencyKey: string) {
    return this.tx.chatbotBotReceipt.findFirst({
      where: { tenantId: this.tenantId, kind, idempotencyKey },
      select: { commandHash: true, responseSnapshot: true },
    });
  }

  async saveReceipt(
    kind: 'CREATE' | 'CANCEL',
    idempotencyKey: string,
    commandHash: string,
    requestId: string | null,
    snapshot: BotCreateResponse | BotCancelResponse,
  ): Promise<void> {
    await this.tx.chatbotBotReceipt.create({
      data: {
        tenantId: this.tenantId,
        kind,
        idempotencyKey,
        commandHash,
        requestId,
        // SAFETY: the snapshots hold only strings, numbers and nulls.
        responseSnapshot: snapshot as unknown as Prisma.InputJsonObject,
      },
    });
  }

  findCreated(sourceRequestId: string) {
    return this.tx.chatbotRequest.findFirst({
      where: {
        tenantId: this.tenantId,
        source: BOT_REQUEST_SOURCE,
        sourceRequestId,
      },
      select: { id: true, folio: true, canonicalRequestHash: true },
    });
  }

  findWrapper(subtype: WrappedSubtype, wrappedId: string) {
    return this.tx.chatbotRequest.findFirst({
      where: {
        tenantId: this.tenantId,
        source: WRAPPER_SOURCE[subtype],
        sourceRequestId: wrappedId,
      },
      select: { id: true, folio: true, canonicalRequestHash: true },
    });
  }

  /**
   * Lock order (rule 2): customer lock, the dedup row, limits, then the folio
   * after every existing-row lock, the insert, and the group last.
   */
  async createDirect(draft: DirectDraft): Promise<IntakeOutcome> {
    const { tx, tenantId } = this;
    const { envelope, credentialId, hash, limits } = draft;
    const customer = envelope.customer;
    if (!customer || !envelope.summary)
      throw new InvalidArgumentError('Invalid');
    const link = await linkByPhone(
      tx,
      tenantId,
      customer.phoneCountryCode,
      customer.phone,
    );
    const customerKey = link.customerKey;
    if (!customerKey) throw new InvalidArgumentError('Invalid');

    await lockCustomerIntake(tx, tenantId, customerKey);
    if (envelope.dedupKey) {
      const open = await findOpenDedup(
        tx,
        tenantId,
        customerKey,
        envelope.dedupKey,
      );
      if (open) return this.merge(open, draft);
    }
    await assertIntakeLimits(tx, tenantId, customerKey, limits);
    await assertTenantLinks(tx, tenantId, { customerId: link.customerId });

    const folio = await allocateFolio(tx, tenantId);
    const lastMessage = envelope.lastCustomerMessageAt;
    const id = await insertRequestOnDedup(tx, {
      tenantId,
      folio,
      kind:
        envelope.subtype === 'UNKNOWN_QUESTION'
          ? 'CLARIFICATION'
          : 'CONVERSATION',
      subtype: envelope.subtype as 'UNKNOWN_QUESTION',
      customerKey,
      customerId: link.customerId,
      ambiguousCustomer: link.ambiguousCustomer,
      phoneCountryCode: link.phoneCountryCode,
      phone: link.phone,
      conversationRef: envelope.conversationRef,
      lastCustomerMessageAt: lastMessage,
      whatsappWindowClosesAt: lastMessage
        ? new Date(lastMessage.getTime() + CUSTOMER_REPLY_WINDOW_MS)
        : null,
      summary: envelope.summary,
      needs: envelope.needs,
      context: envelope.context ?? undefined,
      dedupKey: envelope.dedupKey,
      source: BOT_REQUEST_SOURCE,
      sourceRequestId: envelope.sourceRequestId,
      canonicalRequestHash: hash,
      submittedCredentialId: credentialId,
    });
    // Lost the dedup race to a creator that skipped the lock: merge next try.
    if (!id) throw new IntakeMergeSignal();
    await tx.chatbotRequestEvent.create({
      data: {
        tenantId,
        requestId: id,
        type: 'CREATED',
        actorKind: 'SERVICE',
        actorId: credentialId,
        toStatus: 'NEW',
        version: 1,
        data: {
          subtype: envelope.subtype,
          sourceRequestId: envelope.sourceRequestId,
          triggerWaMessageId: envelope.triggerWaMessageId,
        },
      },
    });
    await refreshCustomerGroup(tx, tenantId, customerKey);
    return { outcome: 'CREATED', id, folio, status: 'NEW' };
  }

  /**
   * Recovery after the hook signalled a merge. The key is derived exactly as
   * the creator derived the one the partial unique index holds: `linkByPhone`
   * (the same call `createDirect` and the hook make) on the phone the request
   * is inserted under, which for a zone requester is the phone of its own
   * detail (the envelope customer is only checked against it).
   */
  async mergeOpen(draft: DirectDraft): Promise<IntakeOutcome | null> {
    const { tx, tenantId } = this;
    const { envelope } = draft;
    const phone = insertPhone(envelope);
    if (!phone || !envelope.dedupKey) return null;
    const { customerKey } = await linkByPhone(
      tx,
      tenantId,
      phone.phoneCountryCode,
      phone.phone,
    );
    if (!customerKey) return null;
    await lockCustomerIntake(tx, tenantId, customerKey);
    const open = await findOpenDedup(
      tx,
      tenantId,
      customerKey,
      envelope.dedupKey,
    );
    return open ? this.merge(open, draft) : null;
  }

  private async merge(
    open: OpenRequestRef,
    draft: DirectDraft,
  ): Promise<IntakeOutcome> {
    const { envelope, credentialId } = draft;
    await recordMerge(this.tx, this.tenantId, open, {
      credentialId,
      sourceRequestId: envelope.sourceRequestId,
      triggerWaMessageId: envelope.triggerWaMessageId,
      lastCustomerMessageAt: envelope.lastCustomerMessageAt,
    });
    return {
      outcome: 'MERGED',
      id: open.id,
      folio: open.folio,
      status: open.status,
    };
  }

  // ------------------------------------------------------------------ cancel

  async lockZoneOf(requestId: string): Promise<void> {
    const zone = await findZoneOf(this.tx, this.tenantId, requestId);
    if (zone) await lockZipCode(this.tx, this.tenantId, zone.zipCode);
  }

  lockRequest(requestId: string): Promise<ChatbotRequestRow | null> {
    return lockRequestRow(this.tx, this.tenantId, requestId);
  }

  async applyCancel(
    row: ChatbotRequestRow,
    patch: ChatbotRequestPatch,
    event: ChatbotRequestEventDraft,
  ): Promise<void> {
    await applyRequestPatch(this.tx, this.tenantId, row, patch, event);
    await refreshCustomerGroup(this.tx, this.tenantId, row.customerKey);
  }

  async readResolution(requestId: string): Promise<unknown> {
    const row = await this.tx.chatbotRequest.findFirst({
      where: { tenantId: this.tenantId, id: requestId },
      select: { resolution: true },
    });
    return row?.resolution ?? null;
  }
}
