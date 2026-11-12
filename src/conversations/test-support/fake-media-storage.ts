/**
 * In-memory private storage for the conversation specs: the same port the
 * Spaces adapter implements, with failure injection and a call log, so a spec
 * can prove what was stored, read and deleted without a network.
 */
import { Readable } from 'node:stream';
import type {
  ReceiptStoragePort,
  ReceiptStoredObject,
} from '../../receipts/domain/receipt-storage.port';

export class FakeMediaStorage implements ReceiptStoragePort {
  readonly objects = new Map<string, { bytes: Buffer; mimeType: string }>();
  readonly removed: string[] = [];
  failPut = false;
  failGet = false;
  /** Keys whose `remove` fails (retention retries them). */
  readonly failRemoveFor = new Set<string>();
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
    if (this.failRemoveFor.has(key)) {
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
