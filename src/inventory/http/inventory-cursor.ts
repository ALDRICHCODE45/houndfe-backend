import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { InventoryContractError, parseInventoryId } from './inventory-contract';

export interface MovementCursorPosition {
  createdAt: string;
  id: string;
}
export interface MovementCursorScope {
  tenantId: string;
  productId: string;
  variantId?: string;
  lotId?: string;
}
const DOMAIN = 'inventory-movements-cursor-v1';

function binding(scope: MovementCursorScope): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        DOMAIN,
        scope.tenantId,
        scope.productId,
        scope.variantId ?? null,
        scope.lotId ?? null,
      ]),
    )
    .digest('hex');
}
function position(createdAt: unknown, id: unknown): MovementCursorPosition {
  if (
    typeof createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) ||
    !Number.isFinite(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt ||
    typeof id !== 'string' ||
    parseInventoryId(id) !== id
  )
    throw new InventoryContractError('MALFORMED');
  return { createdAt, id };
}

/**
 * Opaque HMAC continuation for descending (createdAt,id), not a snapshot or
 * grant. The composition layer supplies JWT_SECRET; rotation invalidates
 * cursors. Scope comes from the trusted tenant and parsed query; limit is
 * deliberately unbound.
 */
export class InventoryCursor {
  constructor(private readonly secret: string) {}

  private mac(payload: string): Buffer {
    return createHmac('sha256', this.secret)
      .update(`${DOMAIN}\0${payload}`)
      .digest();
  }

  encode(scope: MovementCursorScope, value: MovementCursorPosition): string {
    const valid = position(value.createdAt, value.id);
    const payload = Buffer.from(
      JSON.stringify([1, binding(scope), valid.createdAt, valid.id]),
    ).toString('base64url');
    return `${payload}.${this.mac(payload).toString('base64url')}`;
  }

  decode(value: string, scope: MovementCursorScope): MovementCursorPosition {
    try {
      if (value.length > 1024 || !/^[\w-]+\.[\w-]{43}$/.test(value))
        throw new Error();
      const [payload, signature] = value.split('.');
      const bytes = Buffer.from(payload, 'base64url');
      const mac = Buffer.from(signature, 'base64url');
      if (
        bytes.toString('base64url') !== payload ||
        mac.toString('base64url') !== signature ||
        !timingSafeEqual(mac, this.mac(payload))
      )
        throw new Error();
      const decoded: unknown = JSON.parse(bytes.toString('utf8'));
      if (
        !Array.isArray(decoded) ||
        decoded.length !== 4 ||
        decoded[0] !== 1 ||
        decoded[1] !== binding(scope)
      )
        throw new Error();
      return position(decoded[2], decoded[3]);
    } catch {
      throw new InventoryContractError('MALFORMED');
    }
  }
}
