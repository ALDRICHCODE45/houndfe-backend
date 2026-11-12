/**
 * Notices of the chatbot request inbox (human-intervention unit 6; contract
 * §5.1, §6.3). Pure rules: which notice type goes to whom, which ones also
 * send an email and how, and what text the in-app list shows. Nothing here
 * touches the database.
 *
 * Outbox contract (R3): every row this module owns has an `eventType` under
 * the reserved prefix, which the generic poller excludes by pattern
 * (`RESERVED_OUTBOX_PREFIX`), so a new dedicated type can never be claimed by
 * the fire-and-forget dispatcher.
 */
import { RESERVED_OUTBOX_PREFIX } from '../../shared/outbox/outbox.types';

/** Producer row, written in the transaction of the state change. */
export const NOTICE_NOTIFY_EVENT_TYPE = `${RESERVED_OUTBOX_PREFIX}notify`;
/** Email job row, written by the notify consumer. */
export const NOTICE_EMAIL_EVENT_TYPE = `${RESERVED_OUTBOX_PREFIX}email`;
/** Every eventType this module owns (a test pins them against the poller). */
export const NOTICE_OUTBOX_EVENT_TYPES = [
  NOTICE_NOTIFY_EVENT_TYPE,
  NOTICE_EMAIL_EVENT_TYPE,
] as const;

/** Inngest event of one email (a batch carries several notifications). */
export const NOTICE_EMAIL_INNGEST_EVENT = 'chatbot-request/email.requested';

/** §5.1 table. Producers for the last three arrive with unit 7. */
export const NOTICE_TYPES = [
  'REQUEST_CREATED',
  'REQUEST_REASSIGNED',
  'REQUEST_CANCELLED',
  'REQUEST_CLAIM_REMINDER',
  'REQUEST_ESCALATION',
  'REQUEST_OVERDUE',
] as const;
export type NoticeType = (typeof NOTICE_TYPES)[number];

/**
 * Who receives a type. `HANDLERS` and `ESCALATION_VIEWERS` are resolved from
 * permissions when the notify row is consumed; `USER` names the person in the
 * row itself.
 */
export type NoticeAudience = 'HANDLERS' | 'ESCALATION_VIEWERS' | 'USER';

const AUDIENCE: Record<NoticeType, NoticeAudience> = {
  REQUEST_CREATED: 'HANDLERS',
  REQUEST_CLAIM_REMINDER: 'HANDLERS',
  REQUEST_ESCALATION: 'ESCALATION_VIEWERS',
  REQUEST_OVERDUE: 'ESCALATION_VIEWERS',
  REQUEST_REASSIGNED: 'USER',
  REQUEST_CANCELLED: 'USER',
};

export const audienceOf = (type: NoticeType): NoticeAudience => AUDIENCE[type];

/** Grants a person needs, as `[action, subject]` pairs (all of them). */
export const AUDIENCE_GRANTS: Record<
  Exclude<NoticeAudience, 'USER'>,
  ReadonlyArray<readonly [string, string]>
> = {
  // §2.5: update needs read.
  HANDLERS: [
    ['read', 'ChatbotRequest'],
    ['update', 'ChatbotRequest'],
  ],
  ESCALATION_VIEWERS: [['read', 'ChatbotEscalation']],
};

/**
 * Why a request closed under the person who was attending it (§5.1: «el
 * cliente canceló o se resolvió solo → quien la atendía»). A notice written
 * before causes existed has none and reads as the customer's cancel.
 */
export const CLOSED_CAUSES = [
  'CUSTOMER',
  'RESOLVED_BY_OTHER',
  'CANCELLED_BY_OTHER',
  'SIBLING_RESOLVED',
  'MERGED',
] as const;
export type ClosedCause = (typeof CLOSED_CAUSES)[number];

/** What the producer writes. Small, and never customer data (§6.3). */
export interface ChatbotRequestNotice {
  type: NoticeType;
  requestId: string;
  folio: number;
  subtype: string;
  /** Idempotency per recipient, e.g. `created:<requestId>`. */
  dedupKey: string;
  /**
   * Required for `USER` audiences. For `ESCALATION_VIEWERS` it is an extra
   * recipient (the assignee, §5.1), added to whoever the permission resolves.
   */
  recipientUserId?: string;
  /** The person who caused the event; they are never notified of it. */
  actorUserId?: string;
  /** `REQUEST_CANCELLED` only: why it closed. */
  cause?: ClosedCause;
  /**
   * `REQUEST_CLAIM_REMINDER` only (SLA sweep): the start of the claim cycle it
   * was written for, in ms. A release restarts the cycle, so a reminder held
   * across it is dropped at consume time.
   */
  claimCycle?: number;
}

/**
 * Why an escalation notice reached a person (S10): they were the request's
 * assignee, or they hold `read:ChatbotEscalation`. Someone who is both is
 * `ASSIGNEE` (the closer relationship wins). Decided when the notification row
 * is created and stored in its payload; it is never recomputed.
 */
export const NOTICE_REASONS = ['ASSIGNEE', 'ESCALATION'] as const;
export type NoticeReason = (typeof NOTICE_REASONS)[number];

/** Only the types sent to `ESCALATION_VIEWERS` (80 % and overdue) have one. */
export const carriesReason = (type: string): boolean =>
  AUDIENCE[type as NoticeType] === 'ESCALATION_VIEWERS';

/** `payload` of an in-app notification: just enough to render and link. */
export interface NoticePayload {
  folio: number;
  subtype: string;
  cause?: ClosedCause;
  /** `REQUEST_ESCALATION` / `REQUEST_OVERDUE` only; absent on older rows. */
  reason?: NoticeReason;
}

// ------------------------------------------------------------------- email

export type EmailMode = 'IMMEDIATE' | 'BATCH' | 'NONE';

/** Live conversations and complaints never wait for a batch (D5). */
const IMMEDIATE_SUBTYPES: ReadonlySet<string> = new Set([
  'TALK_TO_HUMAN',
  'COMPLAINT',
]);

/**
 * §5.1 "Correo" column: only a new request waits in a batch; the other types
 * with email go one per event; a customer cancel is in-app only.
 */
export function emailModeOf(type: NoticeType, subtype: string): EmailMode {
  if (type === 'REQUEST_CANCELLED') return 'NONE';
  if (type === 'REQUEST_CREATED' && !IMMEDIATE_SUBTYPES.has(subtype)) {
    return 'BATCH';
  }
  return 'IMMEDIATE';
}

/** D5: "Nueva solicitud" emails are grouped every 2 minutes. */
export const EMAIL_BATCH_WINDOW_MS = 120_000;

/**
 * End of the fixed clock window that contains `now`. Every batched notice of
 * a window shares it, so the rows of one person are due together and leave in
 * one email without any per-user state.
 */
export function batchWindowEnd(
  now: Date,
  windowMs: number = EMAIL_BATCH_WINDOW_MS,
): Date {
  return new Date((Math.floor(now.getTime() / windowMs) + 1) * windowMs);
}

// -------------------------------------------------------------------- text

export const SUBTYPE_LABEL: Record<string, string> = {
  RESTOCK: 'Reposición de producto',
  EXPIRATION: 'Caducidad',
  DELIVERY_ZONE: 'Zona de entrega',
  TRANSFER_RECEIPT: 'Comprobante de transferencia',
  TALK_TO_HUMAN: 'Conversación en vivo',
  COMPLAINT: 'Queja',
  UNKNOWN_QUESTION: 'Pregunta sin respuesta',
  DISCOUNT: 'Descuento',
};

export const subtypeLabel = (subtype: string): string =>
  SUBTYPE_LABEL[subtype] ?? 'Solicitud';

export const formatFolio = (folio: number): string =>
  `S-${String(folio).padStart(6, '0')}`;

const TITLE: Record<NoticeType, string> = {
  REQUEST_CREATED: 'Nueva solicitud',
  REQUEST_REASSIGNED: 'Te reasignaron una solicitud',
  REQUEST_CANCELLED: 'El cliente canceló la solicitud',
  REQUEST_CLAIM_REMINDER: 'Solicitud sin tomar',
  REQUEST_ESCALATION: 'Solicitud por vencer',
  REQUEST_OVERDUE: 'Solicitud vencida',
};

/** Email subject/heading lead per type ("Nueva solicitud" is §5.1's). */
export const NOTICE_HEADLINE: Record<NoticeType, string> = {
  REQUEST_CREATED: 'Nueva solicitud',
  REQUEST_REASSIGNED: 'Solicitud reasignada a ti',
  REQUEST_CANCELLED: 'Solicitud cancelada',
  REQUEST_CLAIM_REMINDER: 'Solicitud sin tomar',
  REQUEST_ESCALATION: 'Solicitud por vencer',
  REQUEST_OVERDUE: 'Solicitud vencida',
};

/** `REQUEST_CANCELLED` wording by cause; the customer's cancel is the default. */
const CLOSED_TITLE: Record<ClosedCause, string> = {
  CUSTOMER: 'El cliente canceló la solicitud',
  RESOLVED_BY_OTHER: 'Otra persona resolvió la solicitud',
  CANCELLED_BY_OTHER: 'Otra persona canceló la solicitud',
  SIBLING_RESOLVED: 'Se resolvió junto con otras de su zona',
  MERGED: 'Otra persona la unió con otra solicitud del cliente',
};

/** The stored cause when it is one of the closed set; anything else is none. */
export const closedCauseOf = (value: unknown): ClosedCause | null =>
  (CLOSED_CAUSES as readonly unknown[]).includes(value)
    ? (value as ClosedCause)
    : null;

/** §5.2 `title` (<=120) and `body` (<=200), built from type and payload. */
export function noticeText(
  type: string,
  payload: Partial<NoticePayload> | null,
): { title: string; body: string } {
  const title =
    type === 'REQUEST_CANCELLED'
      ? CLOSED_TITLE[closedCauseOf(payload?.cause) ?? 'CUSTOMER']
      : (TITLE[type as NoticeType] ?? 'Aviso');
  const parts = [
    payload?.subtype ? subtypeLabel(payload.subtype) : null,
    typeof payload?.folio === 'number' ? formatFolio(payload.folio) : null,
  ].filter((part): part is string => part !== null);
  return { title, body: parts.join(' · ') };
}

/** `${APP_WEB_URL}/chatbot/solicitudes/:id` (§5.1); no data, no token. */
export function requestDeepLink(appBaseUrl: string, requestId: string): string {
  return `${appBaseUrl.replace(/\/+$/, '')}/chatbot/solicitudes/${requestId}`;
}

// ------------------------------------------------- SLA notices held in time

/** Types written by the SLA sweep; they may be held until an opening. */
export const SLA_NOTICE_TYPES: ReadonlySet<string> = new Set([
  'REQUEST_CLAIM_REMINDER',
  'REQUEST_ESCALATION',
  'REQUEST_OVERDUE',
]);

export type SlaDropReason =
  | 'REQUEST_CLOSED'
  | 'REQUEST_MISSING'
  | 'CLAIMED_SINCE'
  | 'CLAIM_CYCLE_CHANGED';

/** The request as it is when the held notice is consumed. */
export interface SlaNoticeRequestFacts {
  status: 'NEW' | 'IN_PROGRESS' | 'RESOLVED' | 'CANCELLED';
  /** Start of its current claim cycle (creation, `scheduledFor`, last release). */
  claimStart: Date;
}

/**
 * Whether a held SLA notice still applies when it is released (the sweep holds
 * staff notices until the tenant's next opening, so the request can have
 * changed in between). A reason means: drop it, never deliver. Other types are
 * never judged (`null`).
 *
 *   - closed (RESOLVED/CANCELLED): every SLA notice is dropped;
 *   - REQUEST_CLAIM_REMINDER ("sin tomar"): dropped when the request is no
 *     longer NEW, or its claim cycle is not the one it was written for;
 *   - 80 % and overdue of a request that was claimed since still apply: the
 *     assignee and the escalation viewers should know it is late.
 */
export function slaNoticeDropReason(
  notice: { type: string; claimCycle?: number },
  request: SlaNoticeRequestFacts | null,
): SlaDropReason | null {
  if (!SLA_NOTICE_TYPES.has(notice.type)) return null;
  if (!request) return 'REQUEST_MISSING';
  if (request.status === 'RESOLVED' || request.status === 'CANCELLED') {
    return 'REQUEST_CLOSED';
  }
  if (notice.type === 'REQUEST_CLAIM_REMINDER') {
    if (request.status !== 'NEW') return 'CLAIMED_SINCE';
    if (
      notice.claimCycle !== undefined &&
      request.claimStart.getTime() !== notice.claimCycle
    ) {
      return 'CLAIM_CYCLE_CHANGED';
    }
  }
  return null;
}
