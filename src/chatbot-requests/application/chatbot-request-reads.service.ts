/**
 * APPLICATION: staff reads of the chatbot request inbox (human-intervention
 * unit 4; contract §3.8, §12.3, §12.4, §12.6, §12.11, R12).
 *
 * The store returns raw records; this service shapes them for ONE caller:
 *   - every phone goes through `toStaffPhone` (R12) and `customerKey` is
 *     replaced by an opaque sealed token (it holds the phone), including inside
 *     cursors, so no response of this module carries a full number unless the
 *     caller has `read:CustomerPhone`;
 *   - `allowedActions` replays the state machine against the caller's ability;
 *   - the inbox keeps closed requests for 7 days (D17) and the history lists
 *     the older ones, split at one `now` taken per call.
 */
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import {
  displayStatus,
  type ChatbotRequestKind,
  type ChatbotRequestStatus,
  type ChatbotRequestSubtype,
  type StaffCancelReason,
} from '../domain/chatbot-request.commands';
import type { CustomerKeySealer } from '../domain/customer-key-sealer';
import { parseInboxSearch, type InboxSearch } from '../domain/inbox-search';
import { actorDisplayName } from '../domain/actor-display-name';
import type { PermissionCheck } from '../domain/resolve-permissions';
import {
  closedWindowCutoff,
  computeActionAvailability,
  decodeCursor,
  encodeCursor,
  HISTORY_MAX_RANGE_DAYS,
  isSaneDate,
  type ActionAvailability,
  type CursorKind,
} from '../domain/staff-inbox';
import { toStaffPhone } from '../domain/staff-phone';
import type { SlaAnchors, SlaLevel } from '../domain/chatbot-sla';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  ChatbotRequestCommandError,
  formatFolio,
  toState,
  type ZoneImpactView,
} from './chatbot-request-commands.service';

export const CHATBOT_REQUEST_READ_STORE = Symbol('CHATBOT_REQUEST_READ_STORE');
export const CUSTOMER_KEY_SEALER = Symbol('CUSTOMER_KEY_SEALER');
export const INBOX_CLOCK = Symbol('INBOX_CLOCK');
export const SLA_PAUSE_READER = Symbol('SLA_PAUSE_READER');

/**
 * §5.4: `slaPaused` is derived on read from the tenant's calendar ("now is
 * outside hours and the request is open"). One lookup per call, shared by every
 * row of the response.
 */
export interface SlaPauseReader {
  pauseAt(now: Date): Promise<{ paused: boolean; resumesAt: Date | null }>;
  /**
   * S8: the same single policy lookup, serving `slaPaused` AND `slaLevel`.
   * Optional so a reader that only knows `pauseAt` keeps working (levels read
   * as `null`). `level` is pure CPU over the loaded policy.
   */
  viewAt?(now: Date): Promise<{
    pause: { paused: boolean; resumesAt: Date | null };
    level(anchors: SlaAnchors): SlaLevel | null;
  }>;
}

type SlaPause = { paused: boolean; resumesAt: Date | null };
const NOT_PAUSED: SlaPause = { paused: false, resumesAt: null };

/** What one response needs from the tenant's policy: built once per call. */
interface SlaView {
  pause: SlaPause;
  /** `null` for a closed row, no deadline, or a failed computation. */
  levelOf(row: RequestRecord): SlaLevel | null;
}
const NO_VIEW: SlaView = { pause: NOT_PAUSED, levelOf: () => null };

export type InboxTab = 'open' | 'resolved' | 'cancelled' | 'scheduled';
export type AssigneeFilter =
  | { kind: 'me' }
  | { kind: 'unassigned' }
  | { kind: 'user'; id: string };

export interface InboxFilters {
  subtype?: ChatbotRequestSubtype;
  assignee?: AssigneeFilter;
  overdue?: boolean;
  windowClosingSoon?: boolean;
  /** The parsed `q` (§3.8); never `none`/`absent`: the service short-circuits those. */
  search?: Exclude<InboxSearch, { kind: 'none' | 'absent' }>;
}

/** Columns every list row needs; `urgencyAt` only orders and pages. */
export interface RequestRecord {
  id: string;
  folio: number;
  kind: ChatbotRequestKind;
  subtype: ChatbotRequestSubtype;
  status: ChatbotRequestStatus;
  version: number;
  customerKey: string;
  customerId: string | null;
  phoneCountryCode: string | null;
  phone: string | null;
  assigneeUserId: string | null;
  assigneeDisplayName: string | null;
  claimedAt: Date | null;
  claimDeadlineAt: Date | null;
  resolveDeadlineAt: Date | null;
  overdueAt: Date | null;
  whatsappWindowClosesAt: Date | null;
  scheduledFor: Date | null;
  requiresTemplateAtStart: boolean;
  needsReschedule: boolean;
  summary: string;
  createdAt: Date;
  closedAt: Date | null;
  resolvedByActorId: string | null;
  resolvedByDisplayName: string | null;
  urgencyAt: Date | null;
  /**
   * S8, all optional so a store that does not select them (and the pre-S8
   * fixtures) keep working: they read as "unknown / none".
   */
  cancelReason?:
    | 'CUSTOMER_WITHDREW'
    | 'SUPERSEDED'
    | 'AUTO_RESOLVED'
    | 'STAFF'
    | null;
  staffCancelReason?: StaffCancelReason | null;
  /** Target of a staff merge, from the source's MERGED event (SUPERSEDED only). */
  mergedInto?: { id: string; folio: number } | null;
  /** Last RELEASED / AUTO_RELEASED event: the start of the claim clock cycle (NEW only). */
  lastReleasedAt?: Date | null;
  /** DELIVERY_ZONE only: the zone request has a validation (the detail's `zoneImpact` rule). */
  zoneHasValidation?: boolean | null;
}

export interface GroupRecord {
  customerKey: string;
  mostUrgentAt: Date | null;
  openCount: number;
  lastClosedAt: Date | null;
  moreRequests: number;
  /**
   * S9: open requests of the customer with `overdueAt` set, exact (not limited
   * to the loaded rows, not narrowed by the filters, like `openCount`). Optional
   * so a store or fixture that does not select it reads as 0.
   */
  overdueCount?: number;
  requests: RequestRecord[];
}

export interface CustomerRecord {
  id: string;
  firstName: string;
  lastName: string | null;
  phoneCountryCode: string | null;
  phone: string | null;
  isTrusted: boolean;
  createdAt: Date;
  priceList: { id: string; name: string } | null;
}

export interface AuditRecord {
  id: string;
  type: string;
  actorKind: string;
  actorId: string | null;
  actorDisplayName: string | null;
  fromStatus: string | null;
  toStatus: string | null;
  version: number;
  data: unknown;
  createdAt: Date;
}

export interface DeliveryRecord {
  deliveryId: string;
  type: string;
  createdAt: Date;
  outcome: string | null;
  attemptedAt: Date | null;
}

export interface OrderRecord {
  saleId: string;
  folio: string | null;
  createdAt: Date;
  totalCents: number;
  status: string;
  paymentStatus: string | null;
}

/** A customer whose canonical phone is the request's `customerKey` (R1). */
export interface CandidateRecord extends CustomerRecord {
  lastOrderAt: Date | null;
}

export interface DetailRecord {
  request: RequestRecord & {
    needs: string | null;
    context: unknown;
    resolution: unknown;
    resolvedAt: Date | null;
    ambiguousCustomer: boolean;
  };
  customer: CustomerRecord | null;
  /** `link-customer` choices; empty unless the request has no customer. */
  candidates: CandidateRecord[];
  /** Another open request could take this one (§12.11 candidate rule). */
  hasMergeCandidate: boolean;
  recentOrders: OrderRecord[];
  otherOpen: RequestRecord[];
  /** The wrapped table's projection (§12.6), `null` for other kinds. */
  decision: Record<string, unknown> | null;
  zoneImpact: ZoneImpactView | null;
  audit: AuditRecord[];
  deliveries: DeliveryRecord[];
}

export interface InboxCounts {
  new: number;
  inProgress: number;
  mine: number;
  overdue: number;
  windowClosingSoon: number;
  scheduled: number;
  needsReschedule: number;
  /** S8: requests resolved / cancelled with `closedAt` in the last 7 days (D17 window). */
  resolved7d: number;
  cancelled7d: number;
  /** S8: customers with at least one open request (the open tab's group count). */
  openGroups: number;
  /** S9: open requests with no assignee (the «Sin responsable» filter's total). */
  unassigned: number;
}

interface PageQuery {
  userId: string;
  now: Date;
  cutoff: Date;
  limit: number;
}

export interface HistoryQuery {
  cutoff: Date;
  limit: number;
  cursor: Array<string | null> | null;
  subtype?: ChatbotRequestSubtype;
  resolvedBy?: string;
  from?: Date;
  to?: Date;
  customerKey?: string;
}

export interface ChatbotRequestReadStore {
  tenantId(): string;
  groups(
    query: PageQuery & {
      tab: InboxTab;
      filters: InboxFilters;
      cursor: Array<string | null> | null;
    },
  ): Promise<GroupRecord[]>;
  listByCustomer(
    query: PageQuery & {
      customerKey: string;
      tab: InboxTab;
      /** S9: the same filters, and the same SQL, as the groups. */
      filters: InboxFilters;
      cursor: Array<string | null> | null;
    },
  ): Promise<RequestRecord[]>;
  counts(userId: string, now: Date): Promise<InboxCounts>;
  history(query: HistoryQuery): Promise<RequestRecord[]>;
  findDetail(id: string, now: Date): Promise<DetailRecord | null>;
  mergeCandidates(id: string): Promise<RequestRecord[] | null>;
  audit(
    id: string,
    cursor: Array<string | null> | null,
    limit: number,
  ): Promise<AuditRecord[] | null>;
  customers(ids: string[]): Promise<CustomerRecord[]>;
  /**
   * Unit 8 (realtime): the rows of several requests of the tenant by id, in
   * one query, with the same columns as every list row. Optional so a store
   * (or a test fake) that never serves the stream keeps compiling.
   */
  byIds?(ids: string[]): Promise<RequestRecord[]>;
  /** Active members holding read + update:ChatbotRequest, by name. */
  assignableUsers(): Promise<
    Array<{ id: string; name: string; email: string }>
  >;
}

/** Who is asking: the JWT user and the guard-built CASL ability. */
export interface StaffReader {
  userId: string;
  ability: PermissionCheck;
}

export const DEFAULT_PAGE = 25;
export const MAX_PAGE = 50;
export const AUDIT_IN_DETAIL = 20;

/**
 * Unit 8: what one batch of realtime request events needs, loaded once for
 * every recipient of the batch (rows, customers and the tenant's SLA policy).
 */
export interface EventRowsBatch {
  /**
   * The tenant the batch was loaded for. Shaping runs OUTSIDE the tenant's CLS
   * scope (once per recipient, after the load), so the key sealer must not ask
   * the ambient scope which tenant it is.
   */
  tenantId: string;
  rows: Map<string, RequestRecord>;
  customers: Map<string, CustomerRecord>;
  view: SlaView;
}

const iso = (value: Date | null) => (value ? value.toISOString() : null);
const customerName = (c: Pick<CustomerRecord, 'firstName' | 'lastName'>) =>
  [c.firstName, c.lastName].filter(Boolean).join(' ');

@Injectable()
export class ChatbotRequestReadsService {
  private readonly logger = new Logger(ChatbotRequestReadsService.name);

  constructor(
    @Inject(CHATBOT_REQUEST_READ_STORE)
    private readonly store: ChatbotRequestReadStore,
    @Inject(CUSTOMER_KEY_SEALER) private readonly sealer: CustomerKeySealer,
    @Inject(INBOX_CLOCK) private readonly clock: () => Date,
    @Optional()
    @Inject(SLA_PAUSE_READER)
    private readonly pauseReader?: SlaPauseReader,
  ) {}

  /**
   * An empty page has no row to flag: it skips the settings lookup.
   *
   * Fails soft: `slaPaused` and `slaLevel` are derived hints, so a tenant whose
   * policy cannot be loaded or whose calendar cannot be built (corrupt
   * settings, the case the SLA sweep isolates per tenant) reads as "not
   * paused, no level" instead of turning the staff inbox into a 500. One line
   * per failed call (not per row), with the tenant id and the error class
   * only: an error message can carry settings values or customer data.
   */
  private async slaView(now: Date, empty = false): Promise<SlaView> {
    if (!this.pauseReader || empty) return NO_VIEW;
    const tenant = this.store.tenantId();
    let warned = false;
    const warn = (what: string, error: unknown) => {
      if (warned) return;
      warned = true;
      const kind = error instanceof Error ? error.constructor.name : 'unknown';
      this.logger.warn(`${what} (tenant ${tenant}, ${kind})`);
    };
    try {
      if (!this.pauseReader.viewAt) {
        return {
          pause: await this.pauseReader.pauseAt(now),
          levelOf: () => null,
        };
      }
      const view = await this.pauseReader.viewAt(now);
      return {
        pause: view.pause,
        levelOf: (row) => {
          if (row.status !== 'NEW' && row.status !== 'IN_PROGRESS') return null;
          try {
            return view.level({
              subtype: row.subtype,
              status: row.status,
              createdAt: row.createdAt,
              scheduledFor: row.scheduledFor,
              lastReleasedAt: row.lastReleasedAt ?? null,
              overdueAt: row.overdueAt,
            });
          } catch (error) {
            warn('sla level failed, reading as null', error);
            return null;
          }
        },
      };
    } catch (error) {
      warn('sla pause lookup failed, reading as not paused', error);
      return NO_VIEW;
    }
  }

  /** `GET /chatbot-requests/groups` (§3.8). */
  async groups(
    reader: StaffReader,
    input: {
      tab: InboxTab;
      filters: InboxFilters;
      /** Free-text search (§3.8): folio, customer name, or phone digits. */
      q?: string;
      cursor?: string;
      limit?: number;
    },
  ) {
    const now = this.clock();
    const limit = input.limit ?? DEFAULT_PAGE;
    const filters = this.withSearch(reader, input.filters, input.q);
    if (!filters) return { items: [], nextCursor: null };
    const records = await this.store.groups({
      userId: reader.userId,
      now,
      cutoff: closedWindowCutoff(now),
      limit,
      tab: input.tab,
      filters,
      cursor: this.openCursor(
        input.cursor,
        input.tab === 'resolved' || input.tab === 'cancelled'
          ? ['date', 'text']
          : ['date?', 'text'],
        1,
      ),
    });
    const view = await this.slaView(now, records.length === 0);
    const page = records.slice(0, limit);
    const customers = await this.customerIndex(page.flatMap((g) => g.requests));
    const items = page.map((group) => {
      const first = group.requests[0];
      const linked = group.requests.find((r) => r.customerId);
      const customer = linked && customers.get(linked.customerId as string);
      const source = group.requests.find((r) => r.phone) ?? first;
      return {
        customerKey: this.sealKey(group.customerKey),
        customer: {
          id: customer ? customer.id : null,
          displayName: customer ? customerName(customer) : null,
          phone: toStaffPhone(
            this.phoneOf(source, customer ?? null),
            reader.ability,
          ),
          isTrusted: customer?.isTrusted ?? false,
        },
        mostUrgentAt: iso(group.mostUrgentAt),
        ...(group.lastClosedAt
          ? { lastClosedAt: iso(group.lastClosedAt) }
          : {}),
        openCount: group.openCount,
        overdueCount: group.overdueCount ?? 0,
        requests: group.requests.map((r) => this.toRow(r, view, reader)),
        moreRequests: group.moreRequests,
      };
    });
    const last = page[page.length - 1];
    const sortAt =
      last && (input.tab === 'resolved' || input.tab === 'cancelled')
        ? last.lastClosedAt
        : last?.mostUrgentAt;
    return {
      items,
      nextCursor:
        records.length > limit && last
          ? encodeCursor([iso(sortAt ?? null), this.sealKey(last.customerKey)])
          : null,
    };
  }

  /** `GET /chatbot-requests?customerKey=` (§12.3). */
  async listByCustomer(
    reader: StaffReader,
    input: {
      customerKey: string;
      tab: InboxTab;
      /** S9: the filters of `groups`, with the same meaning. */
      filters?: InboxFilters;
      q?: string;
      cursor?: string;
      limit?: number;
    },
  ) {
    const now = this.clock();
    const limit = input.limit ?? DEFAULT_PAGE;
    const open = input.tab === 'open' || input.tab === 'scheduled';
    // A foreign token is a 400 before anything else, filters or not.
    const customerKey = this.openKey(input.customerKey);
    const filters = this.withSearch(reader, input.filters ?? {}, input.q);
    if (!filters) return { items: [], nextCursor: null };
    const records = await this.store.listByCustomer({
      userId: reader.userId,
      now,
      cutoff: closedWindowCutoff(now),
      limit,
      customerKey,
      tab: input.tab,
      filters,
      cursor: this.openCursor(
        input.cursor,
        open ? ['date?', 'date', 'uuid'] : ['date', 'uuid'],
      ),
    });
    const view = await this.slaView(now, records.length === 0);
    const page = records.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.toRow(r, view, reader)),
      nextCursor:
        records.length > limit && last
          ? encodeCursor(
              open
                ? [iso(last.urgencyAt), iso(last.createdAt), last.id]
                : [iso(last.closedAt), last.id],
            )
          : null,
    };
  }

  counts(reader: StaffReader): Promise<InboxCounts> {
    return this.store.counts(reader.userId, this.clock());
  }

  /** `GET /chatbot-requests/history` (§3.8): closed more than 7 days ago. */
  async history(
    reader: StaffReader,
    input: {
      subtype?: ChatbotRequestSubtype;
      resolvedBy?: string;
      from?: Date;
      to?: Date;
      customerKey?: string;
      cursor?: string;
      limit?: number;
    },
  ) {
    void reader;
    const { from, to } = input;
    if ((from === undefined) !== (to === undefined)) {
      throw new InvalidArgumentError(
        'from and to go together',
        'VALIDATION_ERROR',
      );
    }
    if ((from && !isSaneDate(from)) || (to && !isSaneDate(to))) {
      throw new InvalidArgumentError('Invalid date range', 'VALIDATION_ERROR');
    }
    if (from && to) {
      if (to <= from) {
        throw new InvalidArgumentError(
          'to must follow from',
          'VALIDATION_ERROR',
        );
      }
      if (to.getTime() - from.getTime() > HISTORY_MAX_RANGE_DAYS * 86_400_000) {
        throw new ChatbotRequestCommandError('RANGE_TOO_LARGE', 400);
      }
    }
    const limit = input.limit ?? DEFAULT_PAGE;
    const records = await this.store.history({
      cutoff: closedWindowCutoff(this.clock()),
      limit,
      cursor: this.openCursor(input.cursor, ['date', 'uuid']),
      subtype: input.subtype,
      resolvedBy: input.resolvedBy,
      from,
      to,
      customerKey: input.customerKey
        ? this.openKey(input.customerKey)
        : undefined,
    });
    // Closed requests are never paused: no calendar lookup.
    const page = records.slice(0, limit);
    const last = page[page.length - 1];
    // S9: the customer card of a group row, one lookup for the whole page.
    const customers = await this.customerIndex(page);
    return {
      items: page.map((r) => ({
        ...this.toRow(r, NO_VIEW, reader),
        customer: this.customerCard(
          r,
          r.customerId ? (customers.get(r.customerId) ?? null) : null,
          reader,
        ),
      })),
      nextCursor:
        records.length > limit && last
          ? encodeCursor([iso(last.closedAt), last.id])
          : null,
    };
  }

  /** `GET /chatbot-requests/:id` (§3.8, §12.6). */
  async detail(reader: StaffReader, id: string) {
    const now = this.clock();
    const record = await this.store.findDetail(id, now);
    if (!record) throw new ChatbotRequestCommandError('NOT_FOUND', 404);
    const { request, customer } = record;
    const view = await this.slaView(now);
    const row = this.toRow(request, view, reader);
    const audit = record.audit.slice(0, AUDIT_IN_DETAIL);
    const lastAudit = audit[audit.length - 1];
    const resolved = request.status === 'RESOLVED' && request.resolvedAt;
    const resolution =
      resolved && request.resolution && typeof request.resolution === 'object'
        ? {
            ...request.resolution,
            resolvedBy: request.resolvedByActorId
              ? {
                  id: request.resolvedByActorId,
                  displayName: request.resolvedByDisplayName,
                }
              : null,
            resolvedAt: iso(request.resolvedAt),
          }
        : null;
    return {
      ...row,
      needs: request.needs,
      context: request.context ?? null,
      customer: {
        id: customer ? customer.id : null,
        displayName: customer ? customerName(customer) : null,
        phone: toStaffPhone(this.phoneOf(request, customer), reader.ability),
        customerSince: iso(customer?.createdAt ?? null),
        isTrusted: customer?.isTrusted ?? false,
        priceList: customer?.priceList ?? null,
        // R1: several customers share the phone; staff picks one (link-customer).
        ambiguous: request.ambiguousCustomer,
        candidates: record.candidates.map((c) => ({
          id: c.id,
          displayName: customerName(c),
          phone: toStaffPhone(
            { countryCode: c.phoneCountryCode, phone: c.phone },
            reader.ability,
          ),
          isTrusted: c.isTrusted,
          customerSince: c.createdAt.toISOString(),
          lastOrderAt: iso(c.lastOrderAt),
        })),
        recentOrders: record.recentOrders.map((o) => ({
          saleId: o.saleId,
          folio: o.folio,
          createdAt: o.createdAt.toISOString(),
          totalCents: o.totalCents,
          status: o.status,
          paymentStatus: o.paymentStatus,
        })),
      },
      otherOpenRequests: record.otherOpen.map((r) =>
        this.toRow(r, view, reader),
      ),
      decision: record.decision ? { ...record.decision, resolution } : null,
      ...(record.zoneImpact ? { zoneImpact: record.zoneImpact } : {}),
      deliveries: record.deliveries.map((d) => ({
        deliveryId: d.deliveryId,
        type: d.type,
        createdAt: d.createdAt.toISOString(),
        outcome: d.outcome ?? 'PENDING',
        attemptedAt: iso(d.attemptedAt),
        providerStatus: null,
        needsReconciliation: d.outcome === 'DELIVERY_UNKNOWN',
      })),
      audit: audit.map((e) => this.toAudit(e)),
      auditNextCursor:
        record.audit.length > AUDIT_IN_DETAIL && lastAudit
          ? encodeCursor([iso(lastAudit.createdAt), lastAudit.id])
          : null,
      ...computeActionAvailability(
        toState(request),
        reader.ability,
        reader.userId,
        {
          // The resolve route answers 404 for a zone request that has no
          // validation to settle, so it is not offered.
          resolveTargetMissing:
            request.subtype === 'DELIVERY_ZONE' && !record.zoneImpact,
          hasMergeCandidate: record.hasMergeCandidate,
          hasLinkCandidate: record.candidates.length > 0,
          customer: {
            customerId: request.customerId,
            customerKey: request.customerKey,
          },
        },
      ),
    };
  }

  /** `GET /chatbot-requests/:id/audit` (§12.6). */
  async audit(id: string, input: { cursor?: string; limit?: number }) {
    const limit = input.limit ?? MAX_PAGE;
    const records = await this.store.audit(
      id,
      this.openCursor(input.cursor, ['date', 'uuid']),
      limit,
    );
    if (!records) throw new ChatbotRequestCommandError('NOT_FOUND', 404);
    const page = records.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((e) => this.toAudit(e)),
      nextCursor:
        records.length > limit && last
          ? encodeCursor([iso(last.createdAt), last.id])
          : null,
    };
  }

  /**
   * `GET /chatbot-requests/assignable-users` (§3.10): the `reassign` picker.
   * Only `{id, displayName}`: no email, no phone.
   */
  async assignableUsers() {
    const users = await this.store.assignableUsers();
    return {
      items: users.map((user) => ({
        id: user.id,
        displayName: actorDisplayName(user),
      })),
    };
  }

  /**
   * `GET /chatbot-requests/:id/merge-candidates` (§12.11). With a `reader` its
   * rows carry `allowedActions` / `deniedActions` like every row; the
   * controller always passes it.
   */
  async mergeCandidates(id: string, reader?: StaffReader) {
    const records = await this.store.mergeCandidates(id);
    if (!records) throw new ChatbotRequestCommandError('NOT_FOUND', 404);
    const view = await this.slaView(this.clock(), records.length === 0);
    return { items: records.map((r) => this.toRow(r, view, reader)) };
  }

  // ------------------------------------------------------- realtime (unit 8)

  /**
   * Loads, ONCE for every recipient, what the rows of a batch of request
   * events need: the requests, their customers and the SLA policy. Runs in the
   * CLS scope of the tenant (the hub opens it), like every other read.
   */
  async loadEventRows(requestIds: string[]): Promise<EventRowsBatch> {
    const ids = [...new Set(requestIds)];
    const tenantId = this.store.tenantId();
    if (ids.length === 0) {
      return { tenantId, rows: new Map(), customers: new Map(), view: NO_VIEW };
    }
    if (!this.store.byIds) {
      throw new Error('the read store cannot serve realtime rows');
    }
    const records = await this.store.byIds(ids);
    const [customers, view] = await Promise.all([
      this.customerIndex(records),
      this.slaView(this.clock(), records.length === 0),
    ]);
    // The level of a row does not depend on who reads it: compute it once per
    // batch instead of once per recipient (it walks the business calendar).
    const levels = new Map<string, SlaLevel | null>();
    const shared: SlaView = {
      pause: view.pause,
      levelOf: (row) => {
        if (!levels.has(row.id)) levels.set(row.id, view.levelOf(row));
        return levels.get(row.id) ?? null;
      },
    };
    return {
      tenantId,
      rows: new Map(records.map((r) => [r.id, r])),
      customers,
      view: shared,
    };
  }

  /**
   * One recipient's copy of a request event (§12.8): the same row as the
   * inbox (built with the recipient's ability, so `allowedActions` and
   * `deniedActions` are theirs), the customer with the phone through
   * `toStaffPhone`, and `previousCustomerKey` sealed like `customerKey`. A
   * recipient who cannot read requests, or a request that no longer exists,
   * gets `null`: a row is never sent to someone who could not fetch it.
   */
  shapeEventRow(
    batch: EventRowsBatch,
    requestId: string,
    reader: StaffReader,
    previousCustomerKey: string | null = null,
  ) {
    if (!reader.ability.can('read', 'ChatbotRequest')) return null;
    const record = batch.rows.get(requestId);
    if (!record) return null;
    const customer = record.customerId
      ? (batch.customers.get(record.customerId) ?? null)
      : null;
    return {
      request: this.toRow(record, batch.view, reader, batch.tenantId),
      customer: this.customerCard(record, customer, reader),
      previousCustomerKey: previousCustomerKey
        ? this.sealKey(previousCustomerKey, batch.tenantId)
        : null,
    };
  }

  // ------------------------------------------------------------- shaping

  /**
   * One list row. `reader` (the caller) feeds `allowedActions` /
   * `deniedActions`; they are computed from the row's own columns and the
   * caller's abilities, with no query. A row never shows MERGE or
   * LINK_CUSTOMER (they need facts only the detail loads) and an action can
   * still fail at command time if the request changed meanwhile.
   */
  private toRow(
    r: RequestRecord,
    view: SlaView,
    reader?: StaffReader,
    tenantId?: string,
  ) {
    const { pause } = view;
    const state = toState(r);
    const open = r.status === 'NEW' || r.status === 'IN_PROGRESS';
    // Without a caller (an internal call that has none) nothing is offered:
    // the HTTP routes always pass one.
    const actions: ActionAvailability = reader
      ? computeActionAvailability(state, reader.ability, reader.userId, {
          // The detail hides RESOLVE on a zone request with no validation
          // (the route answers 404). A row follows that rule conservatively:
          // unknown counts as "no validation".
          resolveTargetMissing:
            r.subtype === 'DELIVERY_ZONE' && r.zoneHasValidation !== true,
        })
      : { allowedActions: [], deniedActions: [] };
    const cancelReason = open ? null : (r.cancelReason ?? null);
    const merged = r.mergedInto;
    const paused =
      pause.paused && (r.status === 'NEW' || r.status === 'IN_PROGRESS');
    return {
      id: r.id,
      folio: formatFolio(r.folio),
      customerKey: this.sealKey(r.customerKey, tenantId),
      kind: r.kind,
      subtype: r.subtype,
      status: r.status,
      displayStatus: displayStatus(state),
      summary: r.summary,
      assignee: state.assignee
        ? { id: state.assignee.userId, displayName: state.assignee.displayName }
        : null,
      createdAt: r.createdAt.toISOString(),
      claimDeadlineAt: iso(r.claimDeadlineAt),
      resolveDeadlineAt: iso(r.resolveDeadlineAt),
      overdueAt: iso(r.overdueAt),
      // §5.4 derived on read: outside the calendar's hours and still open.
      // Messages (unit 9) and live sessions (unit 11) do not exist yet: their
      // fields keep their final shape.
      slaPaused: paused,
      slaResumesAt: paused ? iso(pause.resumesAt) : null,
      whatsappWindowClosesAt: iso(r.whatsappWindowClosesAt),
      unreadCustomerMessages: 0,
      scheduledFor: iso(r.scheduledFor),
      requiresTemplateAtStart: r.requiresTemplateAtStart,
      needsReschedule: r.needsReschedule,
      liveSession: null,
      closedAt: iso(r.closedAt),
      resolvedBy: r.resolvedByActorId
        ? { id: r.resolvedByActorId, displayName: r.resolvedByDisplayName }
        : null,
      version: r.version,
      // S8. Close cause: null on open and resolved rows. `staffCancelReason`
      // only with STAFF; `mergedInto` only for a staff merge (SUPERSEDED).
      // Internal notes never reach a row.
      cancelReason,
      staffCancelReason:
        cancelReason === 'STAFF' ? (r.staffCancelReason ?? null) : null,
      mergedInto:
        cancelReason === 'SUPERSEDED' &&
        merged &&
        typeof merged.id === 'string' &&
        typeof merged.folio === 'number'
          ? { id: merged.id, folio: formatFolio(merged.folio) }
          : null,
      // The overdue mark wins and needs no policy, so it also holds when the
      // settings cannot be read (the fail-soft path).
      slaLevel: open ? (r.overdueAt ? 'OVERDUE' : view.levelOf(r)) : null,
      ...actions,
    };
  }

  private toAudit(e: AuditRecord) {
    return {
      id: e.id,
      type: e.type,
      createdAt: e.createdAt.toISOString(),
      actor: {
        kind: e.actorKind,
        id: e.actorId,
        displayName: e.actorDisplayName,
      },
      fromStatus: e.fromStatus,
      toStatus: e.toStatus,
      version: e.version,
      data: e.data ?? {},
    };
  }

  /**
   * Parses `q` and merges it into the filters; `null` when the search can match
   * nothing. Phone search needs `read:CustomerPhone`; without it a digits-only
   * q matches nothing, so no route is an oracle for phone numbers (R12). One
   * rule for `groups` and the by-customer list.
   */
  private withSearch(
    reader: StaffReader,
    filters: InboxFilters,
    q: string | undefined,
  ): InboxFilters | null {
    const search = parseInboxSearch(q, {
      canSearchPhone: reader.ability.can('read', 'CustomerPhone'),
    });
    if (search.kind === 'none') return null;
    return search.kind === 'absent' ? filters : { ...filters, search };
  }

  /** `{id, displayName, phone, isTrusted}`: the phone only through R12. */
  private customerCard(
    request: Pick<RequestRecord, 'phoneCountryCode' | 'phone'>,
    customer: CustomerRecord | null,
    reader: StaffReader,
  ) {
    return {
      id: customer ? customer.id : null,
      displayName: customer ? customerName(customer) : null,
      phone: toStaffPhone(this.phoneOf(request, customer), reader.ability),
      isTrusted: customer?.isTrusted ?? false,
    };
  }

  private phoneOf(
    request: Pick<RequestRecord, 'phoneCountryCode' | 'phone'>,
    customer: Pick<CustomerRecord, 'phoneCountryCode' | 'phone'> | null,
  ) {
    const own = request.phone !== null ? request : customer;
    return {
      countryCode: own?.phoneCountryCode ?? null,
      phone: own?.phone ?? null,
    };
  }

  private async customerIndex(rows: RequestRecord[]) {
    const ids = [
      ...new Set(rows.flatMap((r) => (r.customerId ? [r.customerId] : []))),
    ];
    const found = ids.length ? await this.store.customers(ids) : [];
    return new Map(found.map((c) => [c.id, c]));
  }

  private sealKey(key: string, tenantId?: string) {
    return this.sealer.seal(tenantId ?? this.store.tenantId(), key);
  }

  /** A sealed `customerKey` from the client; anything else is a 400. */
  private openKey(token: string): string {
    const key = this.sealer.open(this.store.tenantId(), token);
    if (key === null) {
      throw new InvalidArgumentError('Invalid customerKey', 'VALIDATION_ERROR');
    }
    return key;
  }

  /**
   * Decodes a cursor of `arity` parts. `keyAt` marks the part holding a
   * sealed `customerKey` (cursors never carry the raw key either).
   */
  private openCursor(
    raw: string | undefined,
    kinds: CursorKind[],
    keyAt?: number,
  ): Array<string | null> | null {
    if (raw === undefined) return null;
    const parts = decodeCursor(raw, kinds);
    if (keyAt !== undefined) {
      const token = parts[keyAt];
      parts[keyAt] = token === null ? null : this.openKey(token);
      if (parts[keyAt] === null) {
        throw new InvalidArgumentError('Invalid cursor', 'VALIDATION_ERROR');
      }
    }
    return parts;
  }
}
