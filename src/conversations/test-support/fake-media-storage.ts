/**
 * In-memory private storage for the conversation specs: the same port the
 * Spaces adapter implements, with failure injection and a call log, so a spec
 * can prove what was stored, read and deleted without a network.
 */
import { Readable } from 'node:stream';
import type {
  ConversationMediaLister,
  ListedObject,
} from '../application/conversation-media-lister';
import type {
  ReceiptStoragePort,
  ReceiptStoredObject,
} from '../../receipts/domain/receipt-storage.port';

export class FakeMediaStorage
  implements ReceiptStoragePort, ConversationMediaLister
{
  readonly objects = new Map<
    string,
    { bytes: Buffer; mimeType: string; lastModified?: Date }
  >();
  /** Keys whose `list` page fails (the sweep must survive a storage outage). */
  failList = false;
  /** Every `list` call, to prove the sweep stays inside its prefix. */
  readonly listCalls: Array<{ prefix: string; limit: number }> = [];
  readonly removed: string[] = [];
  failPut = false;
  failGet = false;
  /** Keys whose `remove` fails (retention retries them). */
  readonly failRemoveFor = new Set<string>();
  /** Every `remove` fails (a storage outage while cleaning up). */
  failRemoveAll = false;
  /** Delays `putPrivate` (race specs). */
  putDelayMs = 0;

  async putPrivate(input: {
    key: string;
    bytes: Buffer;
    mimeType: string;
  }): Promise<void> {
    if (this.putDelayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.putDelayMs));
    }
    if (this.failPut) throw new Error('storage down');
    this.objects.set(input.key, {
      bytes: input.bytes,
      mimeType: input.mimeType,
      lastModified: new Date(),
    });
  }

  /** Back-dates an object (specs cannot wait a day). */
  age(key: string, ms: number): void {
    const object = this.objects.get(key);
    if (object) object.lastModified = new Date(Date.now() - ms);
  }

  list(input: {
    prefix: string;
    startAfter: string | null;
    limit: number;
  }): Promise<{ objects: ListedObject[]; truncated: boolean }> {
    this.listCalls.push({ prefix: input.prefix, limit: input.limit });
    if (this.failList) return Promise.reject(new Error('storage down'));
    const keys = [...this.objects.keys()]
      .filter(
        (key) =>
          key.startsWith(input.prefix) &&
          (input.startAfter === null || key > input.startAfter),
      )
      .sort();
    const page = keys.slice(0, input.limit);
    return Promise.resolve({
      objects: page.map((key) => ({
        key,
        lastModified: this.objects.get(key)?.lastModified ?? null,
      })),
      truncated: keys.length > input.limit,
    });
  }

  getPrivate(key: string): Promise<ReceiptStoredObject | null> {
    if (this.failGet) return Promise.reject(new Error('storage down'));
    const object = this.objects.get(key);
    if (!object) return Promise.resolve(null);
    return Promise.resolve({
      body: Readable.from([object.bytes]),
      contentLength: object.bytes.length,
    });
  }

  remove(key: string): Promise<void> {
    if (this.failRemoveAll || this.failRemoveFor.has(key)) {
      return Promise.reject(new Error('delete failed'));
    }
    this.objects.delete(key);
    this.removed.push(key);
    return Promise.resolve();
  }

  async delete(key: string): Promise<void> {
    try {
      await this.remove(key);
    } catch {
      // Best effort, like the adapter.
    }
  }
}
