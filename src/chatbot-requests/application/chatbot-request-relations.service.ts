/**
 * APPLICATION: the staff commands that relate requests to each other or to a
 * customer (human-intervention unit 4, slice 4b; contract §3.8, §12.11,
 * §12.12, R1).
 *
 *   merge          `{expectedVersion, intoRequestId, intoExpectedVersion}`
 *   link-customer  `{expectedVersion, customerId}`
 *
 * Both run inside `withStaffReceipt` (Idempotency-Key, one transaction) and
 * follow the lock-order rules of docs/chatbot-requests-model.md:
 *
 *   merge  - an UNLOCKED peek of both rows decides what never changes (the
 *            subtype), so a wrapped request, a zone one included, is refused
 *            before any lock. Then both request rows in `id` order, then the
 *            group. Merge is not allowed for wrapped subtypes, so no postal
 *            code lock is ever needed; the locked rows are asserted to have no
 *            wrapped link.
 *   link   - the postal-code lock of every zone request of the customer key
 *            first (sorted, rule 5's zone exception), then every unlinked
 *            request of that key in one `id`-ordered statement. The key never
 *            changes, so no group is touched. A zone request created between
 *            the zip locks and the row lock is DETECTED (its zip is not among
 *            the locked ones): the transaction rolls back and the whole
 *            command runs once more from the start; a second miss is 409.
 */
import { createHash } from 'crypto';
import { Inject, Injectable } from '@nestjs/common';
import {
  isUnknownKey,
  linkCustomer,
  MERGEABLE_SUBTYPES,
  merge,
  type ChatbotRequestError,
  type ChatbotRequestEventDraft,
  type StaffActor,
} from '../domain/chatbot-request.commands';
import { customerHasKey } from '../domain/canonical-phone';
import {
  CHATBOT_REQUEST_COMMAND_STORE,
  ChatbotRequestCommandError,
  toRequestView,
  toState,
  withStaffReceipt,
  type ChatbotRequestCommandStore,
  type ChatbotRequestRow,
  type ChatbotRequestView,
} from './chatbot-request-commands.service';

export const CHATBOT_REQUEST_RELATION_STORE = Symbol(
  'CHATBOT_REQUEST_RELATION_STORE',
);

/** A request locked by link-customer: the row plus its customer and its zip. */
export interface LinkRow extends ChatbotRequestRow {
  customerId: string | null;
  /** Postal code of a DELIVERY_ZONE request, `null` for any other. */
  zipCode: string | null;
}

/**
 * Internal, never leaves the service: link-customer locked a zone request
 * whose postal code it had not locked first (it appeared after the zip locks).
 * Throwing rolls the transaction back; `current` is for the 409 of a second miss.
 */
class LinkZoneRaceSignal extends Error {
  constructor(readonly current: ReturnType<typeof currentOf>) {
    super('link-customer: a zone request appeared after the zip locks');
  }
}

/** Ports of the relation commands; they run on the command store's transaction. */
export interface ChatbotRequestRelationStore {
  /** Unlocked read (ids that are not in this tenant are simply absent). */
  peekRequests(ids: string[]): Promise<ChatbotRequestRow[]>;
  /** `FOR UPDATE`, in `id` order, one statement. */
  lockRequests(ids: string[]): Promise<ChatbotRequestRow[]>;
  /** Audit event on a request whose row this command does not change. */
  recordEvent(
    requestId: string,
    event: ChatbotRequestEventDraft,
  ): Promise<void>;
  /**
   * `request.merged` feed item for the merge's source, on this transaction
   * (feed rule 6: after the state change, before the group refresh).
   */
  enqueueMerged(requestId: string, intoRequestId: string): Promise<void>;
  /**
   * Takes the postal-code locks of the key's zone requests, sorted, and
   * returns the codes it locked.
   */
  lockZonesOfKey(customerKey: string): Promise<string[]>;
  /** Locks the key's unlinked requests plus `anchorId`, in `id` order. */
  lockLinkSet(customerKey: string, anchorId: string): Promise<LinkRow[]>;
  findCustomer(customerId: string): Promise<{
    id: string;
    phoneCountryCode: string | null;
    phone: string | null;
  } | null>;
  /** Links the other requests of the key (no version bump) and audits each. */
  linkSiblings(
    siblings: LinkRow[],
    customerId: string,
    actor: StaffActor,
    viaRequestId: string,
  ): Promise<void>;
}

interface Common {
  requestId: string;
  actorUserId: string;
  idempotencyKey: string;
  expectedVersion: number;
}
export interface MergeInput extends Common {
  /** `update:ChatbotRequestAssignment`, from the caller's CASL ability. */
  actorCanReassign: boolean;
  intoRequestId: string;
  intoExpectedVersion: number;
}
export interface LinkCustomerInput extends Common {
  customerId: string;
}

const hashOf = (parts: unknown[]) =>
  createHash('sha256').update(JSON.stringify(parts), 'utf8').digest('hex');

const currentOf = (row: ChatbotRequestRow) => {
  const view = toRequestView(row);
  return {
    version: row.version,
    status: row.status,
    claimedBy: view.assignee,
  };
};

const failed = (error: ChatbotRequestError, extra?: Record<string, unknown>) =>
  new ChatbotRequestCommandError(
    error.code,
    error.httpStatus,
    error.current,
    extra,
  );

@Injectable()
export class ChatbotRequestRelationsService {
  constructor(
    @Inject(CHATBOT_REQUEST_COMMAND_STORE)
    private readonly commands: ChatbotRequestCommandStore,
    @Inject(CHATBOT_REQUEST_RELATION_STORE)
    private readonly relations: ChatbotRequestRelationStore,
  ) {}

  /**
   * §12.11. Errors: 404 (either id), 409 REQUEST_CLOSED / VERSION_CONFLICT
   * (`current` of the failing side; a target failure also carries
   * `intoRequestId`), 422 MERGE_NOT_ALLOWED.
   */
  merge(input: MergeInput): Promise<ChatbotRequestView> {
    const hash = hashOf([
      'merge',
      input.requestId,
      input.expectedVersion,
      input.intoRequestId,
      input.intoExpectedVersion,
    ]);
    const { actorUserId, idempotencyKey } = input;
    return withStaffReceipt(
      this.commands,
      actorUserId,
      idempotencyKey,
      hash,
      async () => {
        const actor = await this.commands.findActor(actorUserId);
        if (!actor) throw new ChatbotRequestCommandError('UNAUTHORIZED', 401);
        const ids = [input.requestId, input.intoRequestId];

        // Subtype never changes: refuse a wrapped one before taking any lock.
        const peeked = await this.relations.peekRequests(ids);
        this.assertBoth(peeked, input);
        for (const row of peeked) {
          if (!MERGEABLE_SUBTYPES.includes(row.subtype)) {
            throw new ChatbotRequestCommandError(
              'MERGE_NOT_ALLOWED',
              422,
              currentOf(row),
              row.id === input.requestId
                ? undefined
                : { intoRequestId: input.intoRequestId },
            );
          }
        }

        // `request.merged` names ONE conversation, so source and target must
        // share it. Checked before any lock on what the peek saw, and again
        // under the lock (in `merge`).
        const [peekSource, peekTarget] = this.assertBoth(peeked, input);
        if (
          peekSource.conversationRef === null ||
          peekTarget.conversationRef !== peekSource.conversationRef
        ) {
          throw new ChatbotRequestCommandError(
            'MERGE_NOT_ALLOWED',
            409,
            currentOf(peekTarget),
            { intoRequestId: input.intoRequestId },
          );
        }

        const locked = await this.relations.lockRequests(ids);
        const [source, target] = this.assertBoth(locked, input);
        if (this.hasWrappedLink(source) || this.hasWrappedLink(target)) {
          throw new Error('a mergeable subtype has a wrapped link');
        }
        const result = merge(
          { ...pick(source), state: toState(source) },
          { ...pick(target), state: toState(target) },
          {
            actor,
            actorCanReassign: input.actorCanReassign,
            expectedVersion: input.expectedVersion,
            intoExpectedVersion: input.intoExpectedVersion,
            now: new Date(),
          },
        );
        if (!result.ok) {
          throw failed(
            result.error,
            result.on === 'TARGET'
              ? { intoRequestId: input.intoRequestId }
              : undefined,
          );
        }
        // Request rows are locked; the source close tells its assignee (cause
        // MERGED), then the target's event, then the group (rule 1 and 3).
        await this.commands.applyPatch(
          source,
          result.source.patch,
          result.source.event,
        );
        await this.relations.recordEvent(target.id, result.target.event);
        await this.relations.enqueueMerged(source.id, target.id);
        await this.commands.refreshGroups([source.customerKey]);
        return toRequestView({
          ...source,
          ...result.source.patch,
        } as ChatbotRequestRow);
      },
    );
  }

  /**
   * R1 (§3.8). Errors: 404 (request, or a customer of another tenant),
   * 409 REQUEST_CLOSED / VERSION_CONFLICT, 422 ACTION_NOT_ALLOWED (already
   * linked, or an `unknown:` key), 422 CUSTOMER_PHONE_MISMATCH. Links the
   * request and every other unlinked request of the same customer key.
   */
  async linkCustomer(input: LinkCustomerInput): Promise<ChatbotRequestView> {
    try {
      return await this.linkOnce(input);
    } catch (error) {
      if (!(error instanceof LinkZoneRaceSignal)) throw error;
    }
    // The first attempt rolled back, nothing is stored: run it again from the
    // start, which now locks the new zip first. A second miss is a conflict.
    try {
      return await this.linkOnce(input);
    } catch (error) {
      if (error instanceof LinkZoneRaceSignal) {
        throw new ChatbotRequestCommandError(
          'VERSION_CONFLICT',
          409,
          error.current,
        );
      }
      throw error;
    }
  }

  private linkOnce(input: LinkCustomerInput): Promise<ChatbotRequestView> {
    const hash = hashOf([
      'link-customer',
      input.requestId,
      input.expectedVersion,
      input.customerId,
    ]);
    const { actorUserId, idempotencyKey } = input;
    return withStaffReceipt(
      this.commands,
      actorUserId,
      idempotencyKey,
      hash,
      async () => {
        const actor = await this.commands.findActor(actorUserId);
        if (!actor) throw new ChatbotRequestCommandError('UNAUTHORIZED', 401);
        const [peek] = await this.relations.peekRequests([input.requestId]);
        if (!peek) throw new ChatbotRequestCommandError('NOT_FOUND', 404);

        // Zone rule (model doc, rule 5): postal codes before request rows.
        const zipsLocked = new Set<string>(
          isUnknownKey(peek.customerKey)
            ? []
            : await this.relations.lockZonesOfKey(peek.customerKey),
        );
        const rows = await this.relations.lockLinkSet(
          peek.customerKey,
          input.requestId,
        );
        const anchor = rows.find((row) => row.id === input.requestId);
        if (!anchor) throw new ChatbotRequestCommandError('NOT_FOUND', 404);
        // A zone request created after the zip locks was locked without its
        // zip: roll back and let `linkCustomer` retry from the start.
        if (
          rows.some((r) => r.zipCode !== null && !zipsLocked.has(r.zipCode))
        ) {
          throw new LinkZoneRaceSignal(currentOf(anchor));
        }
        const result = linkCustomer(toState(anchor), {
          actor,
          expectedVersion: input.expectedVersion,
          customerId: input.customerId,
          current: {
            customerId: anchor.customerId,
            customerKey: anchor.customerKey,
          },
        });
        if (!result.ok) throw failed(result.error);

        // A customer of another tenant is as good as missing (M3).
        const customer = await this.relations.findCustomer(input.customerId);
        if (!customer) throw new ChatbotRequestCommandError('NOT_FOUND', 404);
        if (!customerHasKey(customer, anchor.customerKey)) {
          throw new ChatbotRequestCommandError(
            'CUSTOMER_PHONE_MISMATCH',
            422,
            currentOf(anchor),
          );
        }
        await this.commands.applyPatch(anchor, result.patch, result.event);
        await this.relations.linkSiblings(
          rows.filter((row) => row.id !== anchor.id && row.customerId === null),
          input.customerId,
          actor,
          anchor.id,
        );
        return toRequestView({
          ...anchor,
          ...result.patch,
        } as ChatbotRequestRow);
      },
    );
  }

  /** Both ids found, as `[source, target]`; a missing one is 404. */
  private assertBoth(
    rows: ChatbotRequestRow[],
    input: MergeInput,
  ): [ChatbotRequestRow, ChatbotRequestRow] {
    const source = rows.find((row) => row.id === input.requestId);
    const target = rows.find((row) => row.id === input.intoRequestId);
    if (!source || !target) {
      throw new ChatbotRequestCommandError('NOT_FOUND', 404);
    }
    return [source, target];
  }

  private hasWrappedLink(row: ChatbotRequestRow): boolean {
    return (
      row.humanDecisionId !== null ||
      row.deliveryZoneRequestId !== null ||
      row.receiptEvidenceId !== null
    );
  }
}

const pick = (row: ChatbotRequestRow) => ({
  id: row.id,
  folio: row.folio,
  customerKey: row.customerKey,
  conversationRef: row.conversationRef,
});
