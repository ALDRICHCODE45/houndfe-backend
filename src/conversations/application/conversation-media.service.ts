/**
 * APPLICATION: conversation media (human-intervention unit 9; contract §3.6,
 * §6.3, §12.5).
 *
 * Upload (bot, `POST /chatbot-api/media`): the type is decided by the bytes and
 * must be on the allowlist, the size is capped at 10 MB, and the object goes to
 * PRIVATE storage under `conversation-media/<tenantId>/<mediaId>.<ext>` through
 * the same port receipts use (`ReceiptStoragePort`; a different prefix, no new
 * adapter). The key is persisted and never returned. The upload is idempotent
 * by `X-Idempotency-Key` + sha256: the same key and bytes answer the same
 * media; the same key with other bytes is a 409. Two simultaneous uploads of
 * one key race on a unique index; the loser deletes its object and answers the
 * winner's row.
 *
 * Retention of the OBJECT (S2): an intent row is committed before the object is
 * written and dropped once a media row owns it or the object is deleted; the
 * retention sweep reconciles the intents a crash or a failed delete left, and
 * `media_tombstone` covers rows deleted with their object (tenant deletion).
 *
 * Staff read (`GET /chatbot-media/:id`): an authenticated proxy, never a signed
 * or public URL (§12.5): the permission is checked on EVERY request by the
 * controller and the bytes stream through the backend. A purged file is a 410.
 * Logs carry the media id and an error class, never a storage key.
 */
import { Inject, Injectable, Logger } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { ChatbotRequestCommandError } from '../../chatbot-requests/application/chatbot-request-commands.service';
import type {
  ReceiptStoragePort,
  ReceiptStoredObject,
} from '../../receipts/domain/receipt-storage.port';
import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  CONVERSATION_MEDIA_MAX_BYTES,
  detectConversationMedia,
} from '../domain/conversation-media';

export const CONVERSATION_MEDIA_STORE = Symbol('CONVERSATION_MEDIA_STORE');
/** The private storage port (`ReceiptStoragePort`) with the media prefix. */
export const CONVERSATION_MEDIA_STORAGE = Symbol('CONVERSATION_MEDIA_STORAGE');

export interface MediaRow {
  id: string;
  storageKey: string | null;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  purgedAt: Date | null;
}

export interface ConversationMediaStore {
  tenantId(): string;
  findByKey(idempotencyKey: string): Promise<MediaRow | null>;
  /** S2: written and committed BEFORE the object is (see the store). */
  recordIntent(row: { id: string; storageKey: string }): Promise<void>;
  /** S2: the object is owned by a row or deleted: the intent is done. */
  dropIntent(id: string): Promise<void>;
  /** `false` when the key already has a row (another request won the race). */
  insert(row: {
    id: string;
    storageKey: string;
    mimeType: string;
    sizeBytes: number;
    sha256: string;
    idempotencyKey: string;
  }): Promise<boolean>;
  findById(id: string): Promise<MediaRow | null>;
}

export interface MediaUploadView {
  mediaId: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

export interface MediaOpened {
  body: ReceiptStoredObject['body'];
  contentLength: number | null;
  mimeType: string;
}

const KEY =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256 = /^[0-9a-f]{64}$/;

const invalid = (): never => {
  throw new InvalidArgumentError('Invalid media upload');
};

@Injectable()
export class ConversationMediaService {
  private readonly logger = new Logger(ConversationMediaService.name);

  constructor(
    @Inject(CONVERSATION_MEDIA_STORE)
    private readonly store: ConversationMediaStore,
    @Inject(CONVERSATION_MEDIA_STORAGE)
    private readonly storage: ReceiptStoragePort,
  ) {}

  async upload(input: {
    idempotencyKey: unknown;
    file: Buffer | undefined;
    fields: unknown;
  }): Promise<{ created: boolean; media: MediaUploadView }> {
    const key = input.idempotencyKey;
    if (typeof key !== 'string' || !KEY.test(key)) return invalid();
    const declaredSha = parseFields(input.fields);
    const bytes = input.file;
    if (!bytes || bytes.length === 0) return invalid();
    if (bytes.length > CONVERSATION_MEDIA_MAX_BYTES) {
      throw new ChatbotRequestCommandError('MEDIA_TOO_LARGE', 413);
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (declaredSha !== null && declaredSha !== sha256) return invalid();

    // A retry of an upload that already succeeded needs no storage at all.
    const existing = await this.store.findByKey(key);
    if (existing) return { created: false, media: replay(existing, sha256) };

    const detected = detectConversationMedia(bytes);
    if (!detected) {
      throw new ChatbotRequestCommandError('MEDIA_TYPE_NOT_ALLOWED', 415);
    }

    const id = randomUUID();
    const storageKey = `conversation-media/${this.store.tenantId()}/${id}.${detected.extension}`;
    // S2 (PII retention): the intent is durable BEFORE the object exists. Every
    // path below ends with the object owned by a media row, or deleted, and the
    // intent dropped; a crash anywhere in between leaves the intent, which the
    // retention sweep reconciles (row exists -> drop it; no row -> delete the
    // object, then the intent).
    await this.store.recordIntent({ id, storageKey });
    try {
      await this.storage.putPrivate({
        key: storageKey,
        bytes,
        mimeType: detected.mimeType,
      });
    } catch (error) {
      this.logger.error(
        `Conversation media upload to private storage failed (${errorClass(error)})`,
      );
      // A timeout can still have written the object: clean up like any other
      // failure after the write.
      await this.discard(id, storageKey);
      throw new ChatbotRequestCommandError(
        'MEDIA_STORAGE_FAILED',
        503,
        undefined,
        {
          retryAfterSeconds: 5,
        },
      );
    }

    let inserted: boolean;
    try {
      inserted = await this.store.insert({
        id,
        storageKey,
        mimeType: detected.mimeType,
        sizeBytes: bytes.length,
        sha256,
        idempotencyKey: key,
      });
    } catch (error) {
      await this.discard(id, storageKey);
      throw error;
    }
    if (inserted) {
      await this.settleIntent(id);
      return {
        created: true,
        media: {
          mediaId: id,
          mimeType: detected.mimeType,
          sizeBytes: bytes.length,
          sha256,
        },
      };
    }
    // Lost the race for this key: no row points at our object any more.
    await this.discard(id, storageKey);
    const winner = await this.store.findByKey(key);
    if (!winner) {
      throw new ChatbotRequestCommandError('MEDIA_STORAGE_FAILED', 503);
    }
    return { created: false, media: replay(winner, sha256) };
  }

  /**
   * Deletes an object this call wrote and no row owns, REPORTING failure (the
   * adapter's `delete` swallows it and logs the key). The intent is dropped only
   * after the delete succeeded; otherwise it stays and the sweep retries.
   */
  private async discard(id: string, storageKey: string): Promise<void> {
    try {
      await this.storage.remove(storageKey);
    } catch (error) {
      this.logger.warn(
        `Conversation media ${id} not deleted, left for the retention sweep (${errorClass(error)})`,
      );
      return;
    }
    await this.settleIntent(id);
  }

  /** A failed drop is harmless (the sweep sees the row / the missing object). */
  private async settleIntent(id: string): Promise<void> {
    try {
      await this.store.dropIntent(id);
    } catch (error) {
      this.logger.warn(
        `Conversation media ${id} intent not dropped (${errorClass(error)})`,
      );
    }
  }

  /** `variant`: absent or `original`; `thumb` has no file yet (no image library). */
  async open(mediaId: string, variant: unknown): Promise<MediaOpened> {
    if (
      variant !== undefined &&
      variant !== 'original' &&
      variant !== 'thumb'
    ) {
      return invalid();
    }
    const row = await this.store.findById(mediaId);
    if (!row) throw new ChatbotRequestCommandError('MEDIA_NOT_FOUND', 404);
    if (row.purgedAt || !row.storageKey) {
      throw new ChatbotRequestCommandError('MEDIA_PURGED', 410);
    }
    if (variant === 'thumb') {
      throw new ChatbotRequestCommandError('THUMB_UNAVAILABLE', 404);
    }
    let object: ReceiptStoredObject | null;
    try {
      object = await this.storage.getPrivate(row.storageKey);
    } catch (error) {
      this.logger.error(
        `Conversation media read failed for ${mediaId} (${errorClass(error)})`,
      );
      throw new ChatbotRequestCommandError('MEDIA_STORAGE_FAILED', 503);
    }
    if (!object) throw new ChatbotRequestCommandError('MEDIA_NOT_FOUND', 404);
    return {
      body: object.body,
      contentLength: object.contentLength,
      mimeType: row.mimeType,
    };
  }
}

function parseFields(fields: unknown): string | null {
  if (fields === undefined || fields === null) return null;
  if (typeof fields !== 'object' || Array.isArray(fields)) return invalid();
  const entries = Object.entries(fields as Record<string, unknown>);
  for (const [name] of entries) {
    if (name !== 'sha256') return invalid();
  }
  const sha = (fields as Record<string, unknown>).sha256;
  if (sha === undefined) return null;
  if (typeof sha !== 'string' || !SHA256.test(sha)) return invalid();
  return sha;
}

function replay(row: MediaRow, sha256: string): MediaUploadView {
  if (row.sha256 !== sha256) {
    throw new ChatbotRequestCommandError('IDEMPOTENCY_CONFLICT', 409);
  }
  return {
    mediaId: row.id,
    mimeType: row.mimeType,
    sizeBytes: row.sizeBytes,
    sha256: row.sha256,
  };
}

/** An error class is safe to log; its message can carry keys and URLs. */
const errorClass = (error: unknown): string =>
  error instanceof Error ? error.name : 'unknown';
