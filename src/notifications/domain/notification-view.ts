/**
 * The in-app notification as the API and the realtime stream show it (contract
 * §5.2; S10). ONE mapping serves `GET /notifications`, `eventView` and the
 * realtime reader, so the list item and the `notification.created` payload
 * cannot drift. Pure: the row comes from `notification-rows.ts`.
 *
 * Everything the S10 fields need is already in the stored payload
 * (`{folio, subtype, cause?, reason?}`), so older rows read with nulls instead
 * of failing.
 */
import {
  NOTICE_REASONS,
  carriesReason,
  closedCauseOf,
  formatFolio,
  noticeText,
  type ClosedCause,
  type NoticePayload,
  type NoticeReason,
} from './chatbot-request-notice';

export interface NotificationView {
  id: string;
  type: string;
  title: string;
  body: string;
  requestId: string | null;
  createdAt: string;
  readAt: string | null;
  /** `S-000123`, as the inbox shows it; `null` on a row without one. */
  folio: string | null;
  /** The request subtype (`UNKNOWN_QUESTION`, `RESTOCK`, …), not its label. */
  subtype: string | null;
  /** Why a `REQUEST_CANCELLED` closed; `null` for older rows and other types. */
  cause: ClosedCause | null;
  /** `REQUEST_ESCALATION` / `REQUEST_OVERDUE` only; `null` otherwise. */
  reason: NoticeReason | null;
  /** The linked request is `NEW` or `IN_PROGRESS` now; `null` if none/gone. */
  requestOpen: boolean | null;
}

/** A notification joined with the status of its request (if any). */
export interface NotificationViewRow {
  id: string;
  type: string;
  payload: unknown;
  requestId: string | null;
  createdAt: Date;
  readAt: Date | null;
  /** `chatbot_requests.status`; `null` when there is no request or it is gone. */
  requestStatus: string | null;
}

const OPEN_STATUSES: ReadonlySet<string> = new Set(['NEW', 'IN_PROGRESS']);

/** The payload as an object, whatever an older or odd row holds. */
function payloadOf(value: unknown): Partial<NoticePayload> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Partial<NoticePayload>)
    : null;
}

export function toNotificationView(row: NotificationViewRow): NotificationView {
  const payload = payloadOf(row.payload);
  const reason = (NOTICE_REASONS as readonly unknown[]).includes(
    payload?.reason,
  )
    ? (payload?.reason as NoticeReason)
    : null;
  return {
    id: row.id,
    type: row.type,
    ...noticeText(row.type, payload),
    requestId: row.requestId,
    createdAt: row.createdAt.toISOString(),
    readAt: row.readAt?.toISOString() ?? null,
    folio:
      typeof payload?.folio === 'number' ? formatFolio(payload.folio) : null,
    subtype: typeof payload?.subtype === 'string' ? payload.subtype : null,
    cause: closedCauseOf(payload?.cause),
    reason: carriesReason(row.type) ? reason : null,
    requestOpen:
      row.requestId === null || row.requestStatus === null
        ? null
        : OPEN_STATUSES.has(row.requestStatus),
  };
}
