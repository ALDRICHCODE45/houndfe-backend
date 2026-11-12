/**
 * Unit spec of the upload path of `ConversationMediaService` with an in-memory
 * store, for the failures a real database makes hard to stage: an INSERT that
 * COMMITS and then reports an error (connection reset after the autocommit).
 *
 * Contract (§3.6, S2): an object is deleted inline only when it is certain no
 * media row owns it. After an ambiguous insert failure nothing is certain, so
 * the object and its intent are left to the retention sweep, which checks
 * `mediaRowExists` before deleting anything.
 */
import { randomUUID } from 'node:crypto';
import { FakeMediaStorage } from '../test-support/fake-media-storage';
import {
  ConversationMediaService,
  type ConversationMediaStore,
  type MediaRow,
} from './conversation-media.service';

// A real JPEG signature is enough for `detectConversationMedia`.
const JPEG = Buffer.concat([
  Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]),
  Buffer.from('JFIF\0'),
  Buffer.alloc(64, 1),
  Buffer.from([0xff, 0xd9]),
]);

type InsertRow = Parameters<ConversationMediaStore['insert']>[0];

class FakeStore implements ConversationMediaStore {
  readonly rows = new Map<string, MediaRow & { idempotencyKey: string }>();
  readonly intents = new Map<string, string>();
  /** Insert COMMITS the row, then rejects (reset after the autocommit). */
  commitThenThrow = false;
  /** Insert rejects without committing anything. */
  throwBeforeCommit = false;

  tenantId(): string {
    return 'tenant-1';
  }
  findByKey(idempotencyKey: string): Promise<MediaRow | null> {
    const row = [...this.rows.values()].find(
      (r) => r.idempotencyKey === idempotencyKey,
    );
    return Promise.resolve(row ?? null);
  }
  findById(id: string): Promise<MediaRow | null> {
    return Promise.resolve(this.rows.get(id) ?? null);
  }
  recordIntent(row: { id: string; storageKey: string }): Promise<void> {
    this.intents.set(row.id, row.storageKey);
    return Promise.resolve();
  }
  dropIntent(id: string): Promise<void> {
    this.intents.delete(id);
    return Promise.resolve();
  }
  insert(row: InsertRow): Promise<boolean> {
    if (this.throwBeforeCommit) return Promise.reject(new Error('db down'));
    if (
      [...this.rows.values()].some(
        (r) => r.idempotencyKey === row.idempotencyKey,
      )
    ) {
      return Promise.resolve(false);
    }
    this.rows.set(row.id, { ...row, purgedAt: null });
    if (this.commitThenThrow) {
      return Promise.reject(new Error('connection reset'));
    }
    return Promise.resolve(true);
  }
}

function setup() {
  const store = new FakeStore();
  const storage = new FakeMediaStorage();
  const service = new ConversationMediaService(store, storage);
  const upload = (key: string = randomUUID()) =>
    service.upload({ idempotencyKey: key, file: JPEG, fields: undefined });
  return { store, storage, service, upload };
}

describe('ConversationMediaService.upload: ambiguous insert failure', () => {
  it('keeps the object and its intent when the insert committed and then threw', async () => {
    const { store, storage, upload } = setup();
    store.commitThenThrow = true;
    const key = randomUUID();

    await expect(upload(key)).rejects.toThrow('connection reset');

    const [row] = [...store.rows.values()];
    expect(row).toBeDefined();
    // The row owns the object: it must not have been deleted...
    expect(storage.removed).toEqual([]);
    expect(storage.objects.has(row.storageKey as string)).toBe(true);
    // ...and the intent stays for the sweep (it drops it: the row exists).
    expect(store.intents.get(row.id)).toBe(row.storageKey);
  });

  it('the bot retry with the same key replays the row and its object is still there', async () => {
    const { store, storage, upload } = setup();
    store.commitThenThrow = true;
    const key = randomUUID();
    await expect(upload(key)).rejects.toThrow();
    store.commitThenThrow = false;

    const retry = await upload(key);

    expect(retry.created).toBe(false);
    const row = store.rows.get(retry.media.mediaId);
    expect(row).toBeDefined();
    expect(storage.objects.has(row?.storageKey as string)).toBe(true);
    // One object, one row: the retry stored nothing new.
    expect(storage.objects.size).toBe(1);
  });

  it('an insert that did NOT commit also leaves object and intent to the sweep (nothing can prove the row will not appear)', async () => {
    const { store, storage, upload } = setup();
    store.throwBeforeCommit = true;

    await expect(upload()).rejects.toThrow('db down');

    expect(store.rows.size).toBe(0);
    expect(storage.removed).toEqual([]);
    expect(storage.objects.size).toBe(1);
    expect(store.intents.size).toBe(1);
  });

  it('the certain paths still clean up inline: a lost race deletes the loser object and drops its intent', async () => {
    const { store, storage, upload } = setup();
    const key = randomUUID();
    await upload(key);
    // A second request passed `findByKey` before the first committed.
    jest.spyOn(store, 'findByKey').mockResolvedValueOnce(null);

    const second = await upload(key);

    expect(second.created).toBe(false);
    expect(storage.removed).toHaveLength(1);
    expect(storage.objects.size).toBe(1);
    expect(store.intents.size).toBe(0);
  });
});
