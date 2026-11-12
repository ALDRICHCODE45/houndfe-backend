/**
 * DOMAIN: the staff-facing shape of a mirrored message (contract §12.5), shared
 * by the REST read and the realtime `conversation.message` event so both show
 * the same thing. Pure.
 *
 * Nothing that identifies the chat leaves here: no `conversationRef` (it embeds
 * the customer's phone, R12), no `customerKey`, no storage key. A file is only
 * ever an id plus its descriptor; the bytes come through the authenticated
 * proxy (`GET /chatbot-media/:id`).
 */
export interface MessageRecord {
  id: string;
  seq: number;
  direction: string;
  author: string;
  staffUserId: string | null;
  type: string;
  text: string | null;
  mediaId: string | null;
  clientMessageId: string | null;
  providerTimestamp: Date | null;
  receivedAt: Date;
  deliveryStatus: string | null;
}

export interface MediaRecord {
  id: string;
  mimeType: string;
  sizeBytes: number;
  purgedAt: Date | null;
}

export interface MessageView {
  id: string;
  seq: number;
  direction: string;
  author: string;
  staff: { id: string; displayName: string | null } | null;
  type: string;
  text: string | null;
  media: {
    id: string;
    mimeType: string | null;
    sizeBytes: number | null;
    /** Audio length is not read in this unit (no media parser): always null. */
    durationSec: number | null;
    /** Thumbnails need an image library the backend does not have yet. */
    hasThumb: false;
    purged: boolean;
  } | null;
  deliveryStatus: string | null;
  clientMessageId: string | null;
  providerTimestamp: string | null;
  createdAt: string;
}

export function toMessageView(
  row: MessageRecord,
  related: {
    media?: MediaRecord | null;
    staff?: { id: string; displayName: string } | null;
  } = {},
): MessageView {
  const isStaff = row.author === 'STAFF';
  return {
    id: row.id,
    seq: row.seq,
    direction: row.direction,
    author: row.author,
    staff: isStaff
      ? row.staffUserId
        ? {
            id: row.staffUserId,
            displayName: related.staff?.displayName ?? null,
          }
        : null
      : null,
    type: row.type,
    text: row.text,
    media: row.mediaId
      ? related.media
        ? {
            id: related.media.id,
            mimeType: related.media.mimeType,
            sizeBytes: related.media.sizeBytes,
            durationSec: null,
            hasThumb: false,
            purged: related.media.purgedAt !== null,
          }
        : {
            id: row.mediaId,
            mimeType: null,
            sizeBytes: null,
            durationSec: null,
            hasThumb: false,
            purged: true,
          }
      : null,
    deliveryStatus: row.direction === 'OUT' ? row.deliveryStatus : null,
    clientMessageId: isStaff ? row.clientMessageId : null,
    providerTimestamp: row.providerTimestamp?.toISOString() ?? null,
    createdAt: row.receivedAt.toISOString(),
  };
}
