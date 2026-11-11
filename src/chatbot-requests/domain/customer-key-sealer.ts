/**
 * R12: `customerKey` is the canonical E.164 digits of the customer's phone, so
 * returning it (or putting it in a cursor) would leak the full number to a role
 * without `read:CustomerPhone`. Staff responses carry an opaque, reversible
 * token instead; the same token goes back in `?customerKey=` and is opened
 * here. It is the same for every caller (the frontend groups and caches by it
 * whatever the role), and bound to the tenant.
 *
 * Deterministic authenticated encryption (SIV style): the IV is an HMAC of the
 * tenant and key, so one customer always yields one token, and AES-256-GCM
 * with the tenant as AAD makes a token useless in another tenant or when
 * altered. Both keys derive from a server secret with HKDF; rotating the secret
 * only makes old tokens answer 400, never a leak.
 */
import { createCipheriv, createDecipheriv, createHmac, hkdfSync } from 'crypto';

const PREFIX = 'k1.';
const IV_BYTES = 12;
const TAG_BYTES = 16;

export class CustomerKeySealer {
  private readonly encryptionKey: Buffer;
  private readonly ivKey: Buffer;

  constructor(secret: string) {
    if (secret.length < 16) {
      throw new Error('CustomerKeySealer needs a secret of 16+ characters');
    }
    const derive = (info: string) =>
      Buffer.from(hkdfSync('sha256', secret, '', info, 32));
    this.encryptionKey = derive('chatbot-customer-key:encrypt');
    this.ivKey = derive('chatbot-customer-key:iv');
  }

  seal(tenantId: string, customerKey: string): string {
    const iv = createHmac('sha256', this.ivKey)
      .update(`${tenantId}\0${customerKey}`)
      .digest()
      .subarray(0, IV_BYTES);
    const cipher = createCipheriv('aes-256-gcm', this.encryptionKey, iv);
    cipher.setAAD(Buffer.from(tenantId));
    const body = Buffer.concat([
      cipher.update(customerKey, 'utf8'),
      cipher.final(),
    ]);
    return `${PREFIX}${Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64url')}`;
  }

  /** `null` for anything that is not a token of this tenant. */
  open(tenantId: string, token: string): string | null {
    if (!token.startsWith(PREFIX)) return null;
    const raw = Buffer.from(token.slice(PREFIX.length), 'base64url');
    if (raw.length <= IV_BYTES + TAG_BYTES) return null;
    try {
      const decipher = createDecipheriv(
        'aes-256-gcm',
        this.encryptionKey,
        raw.subarray(0, IV_BYTES),
      );
      decipher.setAAD(Buffer.from(tenantId));
      decipher.setAuthTag(raw.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
      return Buffer.concat([
        decipher.update(raw.subarray(IV_BYTES + TAG_BYTES)),
        decipher.final(),
      ]).toString('utf8');
    } catch {
      return null;
    }
  }
}
