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
import { Inject, Injectable } from '@nestjs/common';
import {
  displayStatus,
  type ChatbotRequestKind,
  type ChatbotRequestStatus,
  type ChatbotRequestSubtype,
} from '../domain/chatbot-request.commands';
import type { CustomerKeySealer } from '../domain/customer-key-sealer';
import { parseInboxSearch, type InboxSearch } from '../domain/inbox-search';
import { actorDisplayName } from '../domain/actor-display-name';
import type { PermissionCheck } from '../domain/resolve-permissions';
import {
  closedWindowCutoff,
  computeAllowedActions,
  decodeCursor,
  encodeCursor,
  HISTORY_MAX_RANGE_DAYS,
  isSaneDate,
  type CursorKind,
} from '../domain/staff-inbox';
import { toStaffPhone } from '../domain/staff-phone';
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
}

export interface GroupRecord {
  customerKey: string;
  mostUrgentAt: Date | null;
  openCount: number;
  lastClosedAt: Date | null;
  moreRequests: number;
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

const iso = (value: Date | null) => (value ? value.toISOString() : null);
const customerName = (c: Pick<CustomerRecord, 'firstName' | 'lastName'>) =>
  [c.firstName, c.lastName].filter(Boolean).join(' ');

@Injectable()
export class ChatbotRequestReadsService {
  constructor(
    @Inject(CHATBOT_REQUEST_READ_STORE)
    private readonly store: ChatbotRequestReadStore,
    @Inject(CUSTOMER_KEY_SEALER) private readonly sealer: CustomerKeySealer,
    @Inject(INBOX_CLOCK) private readonly clock: () => Date,
  ) {}

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
    // Phone search needs `read:CustomerPhone`; without it a digits-only q
    // matches nothing, so the route is no oracle for phone numbers (R12).
    const search = parseInboxSearch(input.q, {
      canSearchPhone: reader.ability.can('read', 'CustomerPhone'),
    });
    if (search.kind === 'none') return { items: [], nextCursor: null };
    const records = await this.store.groups({
      userId: reader.userId,
      now,
      cutoff: closedWindowCutoff(now),
      limit,
      tab: input.tab,
      filters:
        search.kind === 'absent' ? input.filters : { ...input.filters, search },
      cursor: this.openCursor(
        input.cursor,
        input.tab === 'resolved' || input.tab === 'cancelled'
          ? ['date', 'text']
          : ['date?', 'text'],
        1,
      ),
    });
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
        requests: group.requests.map((r) => this.toRow(r)),
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
      cursor?: string;
      limit?: number;
    },
  ) {
    const now = this.clock();
    const limit = input.limit ?? DEFAULT_PAGE;
    const open = input.tab === 'open' || input.tab === 'scheduled';
    const records = await this.store.listByCustomer({
      userId: reader.userId,
      now,
      cutoff: closedWindowCutoff(now),
      limit,
      customerKey: this.openKey(input.customerKey),
      tab: input.tab,
      cursor: this.openCursor(
        input.cursor,
        open ? ['date?', 'date', 'uuid'] : ['date', 'uuid'],
      ),
    });
    const page = records.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.toRow(r)),
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
    const page = records.slice(0, limit);
    const last = page[page.length - 1];
    return {
      items: page.map((r) => this.toRow(r)),
      nextCursor:
        records.length > limit && last
          ? encodeCursor([iso(last.closedAt), last.id])
          : null,
    };
  }

  /** `GET /chatbot-requests/:id` (§3.8, §12.6). */
  async detail(reader: StaffReader, id: string) {
    const record = await this.store.findDetail(id, this.clock());
    if (!record) throw new ChatbotRequestCommandError('NOT_FOUND', 404);
    const { request, customer } = record;
    const row = this.toRow(request);
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
      otherOpenRequests: record.otherOpen.map((r) => this.toRow(r)),
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
      allowedActions: computeAllowedActions(
        toState(request),
        reader.ability,
        reader.userId,
        {
          // The resolve route answers 404 for a zone request that has no
          // validation to settle, so it is not offered.
          resolveTargetMissing:
            request.subtype === 'DELIVERY_ZONE' && !record.zoneImpact,
          hasMergeCandidate: record.hasMergeCandidate,
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

  /** `GET /chatbot-requests/:id/merge-candidates` (§12.11). */
  async mergeCandidates(id: string) {
    const records = await this.store.mergeCandidates(id);
    if (!records) throw new ChatbotRequestCommandError('NOT_FOUND', 404);
    return { items: records.map((r) => this.toRow(r)) };
  }

  // ------------------------------------------------------------- shaping

  private toRow(r: RequestRecord) {
    const state = toState(r);
    return {
      id: r.id,
      folio: formatFolio(r.folio),
      customerKey: this.sealKey(r.customerKey),
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
      // Working-hours calendar (unit 7), messages (unit 9) and live sessions
      // (unit 11) do not exist yet: the fields keep their final shape.
      slaPaused: false,
      slaResumesAt: null,
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

  private sealKey(key: string) {
    return this.sealer.seal(this.store.tenantId(), key);
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
