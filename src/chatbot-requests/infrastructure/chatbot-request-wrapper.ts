/**
 * Wraps the legacy human flows in a `ChatbotRequest` (human-intervention unit
 * 3; contract §2.1, §2.3, §2.4). It is the single hook the existing intake and
 * resolve paths call, always on the caller's transaction:
 *
 *   creation   `wrapHumanDecision`, `wrapZoneRequest`, `wrapReceipt`: insert
 *              the 1:1 request, its CREATED event and the customer group in
 *              the same transaction as the wrapped row, so a rolled-back
 *              insert leaves no request.
 *   legacy     `lockLegacy` takes the open wrapping requests BEFORE the old
 *              code touches the wrapped row, and `closeLegacy` resolves them
 *              after it succeeded, so a request and its wrapped row never
 *              disagree and both entry points lock in one order: request row,
 *              wrapped row, group (docs/chatbot-requests-model.md).
 *
 * The staff `resolve` command closes the requests itself and runs the old use
 * cases inside `suppressLegacyClose`, so nothing is closed twice.
 *
 * Wrapper rows use `source = WRAP:<TABLE>` and the wrapped id as
 * `sourceRequestId`; the bot's own intake (unit 5) uses its credential source.
 *
 * Envelope mode (unit 5): `POST /chatbot-api/requests` runs a legacy intake
 * inside `withEnvelope`, so the hook adds what the old body never carried
 * (customer, dedup key, summary, the bot's hash) and applies the customer lock,
 * dedup and limits of docs/chatbot-requests-model.md, "Bot intake". A request
 * that must merge rolls the legacy transaction back with `IntakeMergeSignal`.
 */
import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { AsyncLocalStorage } from 'node:async_hooks';
import { CUSTOMER_REPLY_WINDOW_MS } from '../../delivery-zones/domain/delivery-zone.policy';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  ChatbotRequestCommandError,
  formatFolio,
  toState,
} from '../application/chatbot-request-commands.service';
import { canonicalPhone, phoneLookupVariants } from '../domain/canonical-phone';
import { actorDisplayName } from '../domain/actor-display-name';
import { closeWrapped } from '../domain/chatbot-request.commands';
import {
  assertIntakeLimits,
  findOpenDedup,
  insertRequestOnDedup,
  IntakeMergeSignal,
  lockBotKey,
  lockCustomerIntake,
  type IntakeLimits,
} from './chatbot-request-intake-writes';
import {
  enqueueClosedNotice,
  enqueueNotice,
} from '../../notifications/infrastructure/chatbot-request-notice.writer';
import { enqueueAnswered } from './chatbot-feed-writes';
import {
  allocateFolio,
  applyRequestPatch,
  assertTenantLinks,
  lockOpenWrapping,
  refreshCustomerGroup,
  refreshCustomerGroups,
  type TenantClient,
  type WrappedLink,
} from './chatbot-request-writes';

export const WRAP_SOURCE = {
  humanDecision: 'WRAP:HUMAN_DECISION',
  deliveryZoneRequest: 'WRAP:DELIVERY_ZONE_REQUEST',
  receiptEvidence: 'WRAP:RECEIPT_EVIDENCE',
} as const;

const SUMMARY_MAX = 140;
const ASSERT_TX = 'ChatbotRequestWrapper must run inside a transaction';

export interface CustomerLink {
  customerKey: string | null;
  customerId: string | null;
  ambiguousCustomer: boolean;
  phoneCountryCode: string | null;
  phone: string | null;
}

export const NO_CUSTOMER: CustomerLink = {
  customerKey: null,
  customerId: null,
  ambiguousCustomer: false,
  phoneCountryCode: null,
  phone: null,
};

/** What the bot's envelope adds to a wrapped request (see the file doc). */
export interface BotIntakeEnvelope {
  credentialId: string;
  sourceRequestId: string;
  hash: string;
  customer: { phoneCountryCode: string; phone: string } | null;
  summary: string | null;
  needs: string | null;
  context: Record<string, string | number | string[]> | null;
  dedupKey: string | null;
  conversationRef: string | null;
  lastCustomerMessageAt: Date | null;
  triggerWaMessageId: string | null;
  limits: IntakeLimits;
}

export interface NewWrappedRequest {
  subtype: 'RESTOCK' | 'EXPIRATION' | 'DELIVERY_ZONE' | 'TRANSFER_RECEIPT';
  source: string;
  wrappedId: string;
  fallbackKey: string;
  summary: string;
  context: Record<string, string | number | string[] | null>;
  link: CustomerLink;
  wrapped: {
    humanDecisionId?: string;
    deliveryZoneRequestId?: string;
    receiptEvidenceId?: string;
  };
  conversationRef?: string;
  lastCustomerMessageAt?: Date;
}

/** RESTOCK / EXPIRATION carry no customer (§2.3): one group per decision. */
export function humanDecisionWrap(decision: {
  id: string;
  type: 'RESTOCK' | 'EXPIRATION';
  productId: string;
  productName: string;
  variantId: string | null;
}): NewWrappedRequest {
  return {
    subtype: decision.type,
    source: WRAP_SOURCE.humanDecision,
    wrappedId: decision.id,
    fallbackKey: `unknown:${decision.id}`,
    summary: `${decision.type === 'RESTOCK' ? 'Stock' : 'Caducidad'}: ${decision.productName}`,
    context: { productId: decision.productId, variantId: decision.variantId },
    link: NO_CUSTOMER,
    wrapped: { humanDecisionId: decision.id },
  };
}

/** The `link` comes from `linkByPhone`: R1, one lookup per requester. */
export function zoneRequestWrap(
  request: {
    id: string;
    zipCode: string;
    conversationRef: string;
    lastCustomerMessageAt: Date;
  },
  link: CustomerLink,
): NewWrappedRequest {
  return {
    subtype: 'DELIVERY_ZONE',
    source: WRAP_SOURCE.deliveryZoneRequest,
    wrappedId: request.id,
    fallbackKey: `unknown:${request.id}`,
    summary: `Zona de entrega ${request.zipCode}`,
    context: { zipCode: request.zipCode },
    link,
    wrapped: { deliveryZoneRequestId: request.id },
    conversationRef: request.conversationRef,
    lastCustomerMessageAt: request.lastCustomerMessageAt,
  };
}

/** What a receipt takes from its sale: the folio and the customer. */
export interface ReceiptSale {
  folio: string | null;
  customerId: string | null;
  customer: { phoneCountryCode: string | null; phone: string | null } | null;
}

export function findReceiptSale(
  tx: TenantClient,
  tenantId: string,
  saleId: string,
): Promise<ReceiptSale | null> {
  return tx.sale.findFirst({
    where: { id: saleId, tenantId },
    select: {
      folio: true,
      customerId: true,
      customer: { select: { phoneCountryCode: true, phone: true } },
    },
  });
}

/** The customer comes from `Sale.customerId` and that customer's phone. */
export function receiptWrap(
  receipt: { id: string; saleId: string },
  sale: ReceiptSale | null,
): NewWrappedRequest {
  const phoneKey =
    sale?.customer?.phoneCountryCode && sale.customer.phone
      ? normalizedPhone(sale.customer.phoneCountryCode, sale.customer.phone)
      : null;
  // The sale names its customer, so this is not a phone inference (R1).
  const link: CustomerLink = {
    ...NO_CUSTOMER,
    ...(phoneKey ?? {}),
    customerId: sale?.customerId ?? null,
  };
  return {
    subtype: 'TRANSFER_RECEIPT',
    source: WRAP_SOURCE.receiptEvidence,
    wrappedId: receipt.id,
    fallbackKey: `unknown:${receipt.id}`,
    summary: `Comprobante de transferencia${sale?.folio ? ` ${sale.folio}` : ''}`,
    context: { saleId: receipt.saleId },
    link,
    wrapped: { receiptEvidenceId: receipt.id },
  };
}

function normalizedPhone(
  countryCode: string,
  phone: string,
): Pick<CustomerLink, 'customerKey' | 'phoneCountryCode' | 'phone'> | null {
  const key = canonicalPhone(countryCode, phone);
  if (!key) return null;
  const digits = countryCode.replace(/\D/g, '');
  const cc = digits === '521' ? '52' : digits;
  return {
    customerKey: key,
    phoneCountryCode: cc,
    phone: key.slice(cc.length),
  };
}

/**
 * R1: the customer is linked only when the canonical key maps to exactly one
 * `Customer`; with several the request stays unlinked and marked ambiguous,
 * and staff links it by hand.
 */
export async function linkByPhone(
  tx: TenantClient,
  tenantId: string,
  countryCode: string,
  phone: string,
): Promise<CustomerLink> {
  const normalized = normalizedPhone(countryCode, phone);
  if (!normalized?.customerKey) return NO_CUSTOMER;
  const variants = phoneLookupVariants(countryCode, phone);
  const hits = await tx.customer.findMany({
    where: {
      tenantId,
      phoneCountryCode: { in: variants.countryCodes },
      phone: { in: variants.phones },
    },
    select: { id: true, phoneCountryCode: true, phone: true },
    take: 10,
  });
  const same = hits.filter(
    (hit) =>
      hit.phoneCountryCode !== null &&
      hit.phone !== null &&
      canonicalPhone(hit.phoneCountryCode, hit.phone) ===
        normalized.customerKey,
  );
  return {
    ...normalized,
    customerId: same.length === 1 ? same[0].id : null,
    ambiguousCustomer: same.length > 1,
  };
}

/** How the backfill (slice 3b) writes a row the hooks never saw. */
export interface RequestCreateExtras {
  id?: string;
  createdAt?: Date;
  /** Envelope mode: the bot's own columns on the wrapper row. */
  bot?: {
    needs: string | null;
    dedupKey: string | null;
    canonicalRequestHash: string;
    submittedCredentialId: string;
  };
  /** A wrapped row resolved before the backfill: the request is born closed. */
  resolved?: {
    resolvedAt: Date;
    resolvedByActorId: string | null;
    resolvedByDisplayName: string | null;
    resolution: Prisma.InputJsonObject;
  };
}

/**
 * The `chatbot_requests` row of a wrapped flow. The hooks and the backfill
 * both build it here, so the folio, `customerKey`, R1 flag, summary, window
 * and source convention can never differ between them.
 */
export function requestCreateData(
  tenantId: string,
  folio: number,
  input: NewWrappedRequest,
  extras: RequestCreateExtras = {},
): Prisma.ChatbotRequestCreateManyInput {
  const { resolved } = extras;
  return {
    ...(extras.id ? { id: extras.id } : {}),
    ...(extras.createdAt ? { createdAt: extras.createdAt } : {}),
    tenantId,
    folio,
    kind: 'DECISION',
    subtype: input.subtype,
    customerKey: input.link.customerKey ?? input.fallbackKey,
    customerId: input.link.customerId,
    ambiguousCustomer: input.link.ambiguousCustomer,
    phoneCountryCode: input.link.phoneCountryCode,
    phone: input.link.phone,
    conversationRef: input.conversationRef ?? null,
    ...(input.lastCustomerMessageAt
      ? {
          lastCustomerMessageAt: input.lastCustomerMessageAt,
          whatsappWindowClosesAt: new Date(
            input.lastCustomerMessageAt.getTime() + CUSTOMER_REPLY_WINDOW_MS,
          ),
        }
      : {}),
    summary: input.summary.slice(0, SUMMARY_MAX),
    context: input.context,
    source: input.source,
    sourceRequestId: input.wrappedId,
    ...input.wrapped,
    ...(extras.bot ?? {}),
    ...(resolved
      ? {
          status: 'RESOLVED',
          resolvedAt: resolved.resolvedAt,
          closedAt: resolved.resolvedAt,
          resolvedByActorId: resolved.resolvedByActorId,
          resolvedByDisplayName: resolved.resolvedByDisplayName,
          resolution: resolved.resolution,
        }
      : {}),
  };
}

@Injectable()
export class ChatbotRequestWrapper {
  private readonly suppressed = new AsyncLocalStorage<true>();
  private readonly envelopes = new AsyncLocalStorage<BotIntakeEnvelope>();

  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  /** Runs `work` (a legacy use case) without its close hook; see file doc. */
  suppressLegacyClose<T>(work: () => Promise<T>): Promise<T> {
    return this.suppressed.run(true, work);
  }

  /** Runs a legacy intake (outside any transaction) in envelope mode. */
  withEnvelope<T>(
    envelope: BotIntakeEnvelope,
    work: () => Promise<T>,
  ): Promise<T> {
    return this.envelopes.run(envelope, work);
  }

  private get hooksOff(): boolean {
    return this.suppressed.getStore() === true;
  }

  private get tx(): TenantClient {
    if (!this.tenantPrisma.isInTransaction()) throw new Error(ASSERT_TX);
    return this.tenantPrisma.getClient();
  }

  // ---------------------------------------------------------------- creation

  /** RESTOCK / EXPIRATION carry no customer (§2.3): one group per decision. */
  async wrapHumanDecision(
    decision: Parameters<typeof humanDecisionWrap>[0],
  ): Promise<void> {
    await this.insert(humanDecisionWrap(decision));
  }

  /** Only requesters that wait for a human; an EXISTING_ZONE one is resolved. */
  async wrapZoneRequest(request: {
    id: string;
    zipCode: string;
    conversationRef: string;
    customerPhoneCountryCode: string;
    customerPhone: string;
    lastCustomerMessageAt: Date;
  }): Promise<void> {
    await this.insert(
      zoneRequestWrap(
        request,
        await linkByPhone(
          this.tx,
          this.tenantPrisma.getTenantId(),
          request.customerPhoneCountryCode,
          request.customerPhone,
        ),
      ),
    );
  }

  /** The customer comes from `Sale.customerId` and that customer's phone. */
  async wrapReceipt(receipt: { id: string; saleId: string }): Promise<void> {
    const sale = await findReceiptSale(
      this.tx,
      this.tenantPrisma.getTenantId(),
      receipt.saleId,
    );
    await this.insert(receiptWrap(receipt, sale));
  }

  /**
   * Lock order: the wrapped row was inserted by the caller; in envelope mode
   * the customer lock, the dedup row and the limits come next, then the folio
   * after every read and lock, and the group last.
   */
  private async insert(plain: NewWrappedRequest): Promise<void> {
    const { tx } = this;
    const tenantId = this.tenantPrisma.getTenantId();
    const envelope = this.envelopes.getStore();
    const input = envelope
      ? await this.withEnvelopeData(plain, envelope)
      : plain;
    if (envelope) await this.assertKeyFree(tx, tenantId, envelope);
    const customerKey = input.link.customerKey ?? input.fallbackKey;
    await assertTenantLinks(tx, tenantId, {
      customerId: input.link.customerId,
      ...input.wrapped,
    });
    if (envelope && input.link.customerKey) {
      await lockCustomerIntake(tx, tenantId, customerKey);
      if (
        envelope.dedupKey &&
        (await findOpenDedup(tx, tenantId, customerKey, envelope.dedupKey))
      ) {
        throw new IntakeMergeSignal();
      }
      await assertIntakeLimits(tx, tenantId, customerKey, envelope.limits);
    }
    const data = requestCreateData(
      tenantId,
      await allocateFolio(tx, tenantId),
      input,
      envelope && {
        bot: {
          needs: envelope.needs,
          dedupKey: envelope.dedupKey,
          canonicalRequestHash: envelope.hash,
          submittedCredentialId: envelope.credentialId,
        },
      },
    );
    // A lost dedup race (a creator that skipped the lock) merges too.
    const requestId = envelope
      ? await insertRequestOnDedup(tx, data)
      : (await tx.chatbotRequest.create({ data, select: { id: true } })).id;
    if (!requestId) throw new IntakeMergeSignal();
    if (envelope) {
      await this.saveCreateReceipt(
        tx,
        tenantId,
        envelope,
        requestId,
        data.folio,
      );
    }
    await tx.chatbotRequestEvent.create({
      data: {
        tenantId,
        requestId,
        type: 'CREATED',
        actorKind: envelope ? 'SERVICE' : 'SYSTEM',
        actorId: envelope?.credentialId,
        toStatus: 'NEW',
        version: 1,
        data: {
          subtype: input.subtype,
          wrapped: true,
          ...(envelope && {
            sourceRequestId: envelope.sourceRequestId,
            triggerWaMessageId: envelope.triggerWaMessageId,
          }),
        },
      },
    });
    // Unit 6: one outbox row in this transaction; a rollback leaves no notice.
    await enqueueNotice(tx, tenantId, {
      type: 'REQUEST_CREATED',
      requestId,
      folio: data.folio,
      subtype: input.subtype,
      dedupKey: `created:${requestId}`,
    });
    await refreshCustomerGroup(tx, tenantId, customerKey);
  }

  /**
   * The key's advisory lock, then its receipt. A legacy replay of this very
   * key never reaches the hook (the old identity answers first), so a receipt
   * found here was written by the direct path or by another body: conflict.
   */
  private async assertKeyFree(
    tx: TenantClient,
    tenantId: string,
    envelope: BotIntakeEnvelope,
  ): Promise<void> {
    await lockBotKey(tx, tenantId, 'CREATE', envelope.sourceRequestId);
    const taken = await tx.chatbotBotReceipt.count({
      where: {
        tenantId,
        kind: 'CREATE',
        idempotencyKey: envelope.sourceRequestId,
      },
    });
    if (taken > 0) {
      throw new ChatbotRequestCommandError('IDEMPOTENCY_CONFLICT', 409);
    }
  }

  /** Same answer the direct path stores, in the legacy transaction. */
  private async saveCreateReceipt(
    tx: TenantClient,
    tenantId: string,
    envelope: BotIntakeEnvelope,
    requestId: string,
    folio: number,
  ): Promise<void> {
    await tx.chatbotBotReceipt.create({
      data: {
        tenantId,
        kind: 'CREATE',
        idempotencyKey: envelope.sourceRequestId,
        commandHash: envelope.hash,
        requestId,
        responseSnapshot: {
          id: requestId,
          folio: formatFolio(folio),
          status: 'NEW',
          outcome: 'CREATED',
          mergedIntoId: null,
          businessHours: null,
        },
      },
    });
  }

  /** The envelope's customer, summary, context and window go on the request. */
  private async withEnvelopeData(
    input: NewWrappedRequest,
    envelope: BotIntakeEnvelope,
  ): Promise<NewWrappedRequest> {
    // A zone requester is already linked by the phone of its own detail.
    const link =
      input.link.customerKey || !envelope.customer
        ? input.link
        : await linkByPhone(
            this.tx,
            this.tenantPrisma.getTenantId(),
            envelope.customer.phoneCountryCode,
            envelope.customer.phone,
          );
    const lastCustomerMessageAt =
      input.lastCustomerMessageAt ?? envelope.lastCustomerMessageAt;
    return {
      ...input,
      link,
      summary: envelope.summary ?? input.summary,
      context: { ...envelope.context, ...input.context },
      conversationRef:
        input.conversationRef ?? envelope.conversationRef ?? undefined,
      ...(lastCustomerMessageAt ? { lastCustomerMessageAt } : {}),
    };
  }

  // ----------------------------------------------------------- legacy routes

  /** The legacy receipt routes only know the id; the name may be empty. */
  private async nameOf(userId: string): Promise<string> {
    const user = await this.tx.user.findUnique({
      where: { id: userId },
      select: { name: true, email: true },
    });
    if (!user) throw new Error('legacy resolve by an unknown user');
    return actorDisplayName(user);
  }

  /** Call before the legacy code writes the wrapped row (lock order). */
  async lockLegacy(link: WrappedLink): Promise<void> {
    if (this.hooksOff) return;
    await lockOpenWrapping(this.tx, this.tenantPrisma.getTenantId(), link);
  }

  /**
   * Call after the legacy resolve wrote the wrapped row. Resolves every open
   * wrapping request with the legacy action (the whole zone set, for a zone).
   * An already closed request is left alone.
   */
  async closeLegacy(
    link: WrappedLink,
    actor: { userId: string; displayName?: string },
    action: string,
    details: Record<string, unknown> = {},
  ): Promise<void> {
    if (this.hooksOff) return;
    const { tx } = this;
    const tenantId = this.tenantPrisma.getTenantId();
    const rows = await lockOpenWrapping(tx, tenantId, link);
    if (rows.length === 0) return;
    const displayName =
      actor.displayName?.trim() || (await this.nameOf(actor.userId));
    const now = new Date();
    const closedIds: string[] = [];
    for (const row of rows) {
      const closed = closeWrapped(toState(row), {
        actor: { userId: actor.userId, displayName },
        action,
        now,
        resolution: { action, via: 'LEGACY_ROUTE', ...details },
        data: { via: 'LEGACY_ROUTE' },
      });
      if (!closed.ok) continue;
      await applyRequestPatch(tx, tenantId, row, closed.patch, closed.event);
      // Unit 6 (§5.1): whoever was attending it hears it closed without them.
      await enqueueClosedNotice(
        tx,
        tenantId,
        row,
        'RESOLVED_BY_OTHER',
        actor.userId,
      );
      closedIds.push(row.id);
    }
    // The legacy routes feed the bot too (one state, §2.1): same item as the
    // staff `resolve`, read from the wrapped row the old code just wrote.
    await enqueueAnswered(tx, tenantId, closedIds);
    await refreshCustomerGroups(
      tx,
      tenantId,
      rows.map((row) => row.customerKey),
    );
  }
}
