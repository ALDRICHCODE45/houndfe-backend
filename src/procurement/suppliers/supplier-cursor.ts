import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { parseSupplierId, SupplierContractError } from './supplier-contract';
import type { SupplierListQuery } from './supplier-contract';

export interface SupplierCursorPosition {
  createdAt: string;
  id: string;
}
export type SupplierCursorScope = Pick<
  SupplierListQuery,
  'status' | 'search'
> & { tenantId: string };
const DOMAIN = 'procurement-suppliers-cursor-v1';

function binding(scope: SupplierCursorScope): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        DOMAIN,
        scope.tenantId,
        scope.status,
        scope.search ?? null,
      ]),
    )
    .digest('hex');
}
function position(createdAt: unknown, id: unknown): SupplierCursorPosition {
  if (
    typeof createdAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(createdAt) ||
    !Number.isFinite(Date.parse(createdAt)) ||
    new Date(createdAt).toISOString() !== createdAt ||
    parseSupplierId(id) !== id
  )
    throw new SupplierContractError('MALFORMED');
  return { createdAt, id: id };
}

/** Authenticated opaque continuation, not a snapshot or an authorization grant.
 * Domain-separated existing JWT_SECRET avoids a new deployment secret. Rotation
 * invalidates outstanding cursors; callers must restart listing explicitly.
 */
@Injectable()
export class SupplierCursor {
  constructor(private readonly config: ConfigService) {}

  private mac(payload: string): Buffer {
    return createHmac('sha256', this.config.getOrThrow<string>('JWT_SECRET'))
      .update(`${DOMAIN}\0${payload}`)
      .digest();
  }

  encode(scope: SupplierCursorScope, value: SupplierCursorPosition): string {
    const valid = position(value.createdAt, value.id);
    const payload = Buffer.from(
      JSON.stringify([1, binding(scope), valid.createdAt, valid.id]),
    ).toString('base64url');
    return `${payload}.${this.mac(payload).toString('base64url')}`;
  }

  decode(value: string, scope: SupplierCursorScope): SupplierCursorPosition {
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
      throw new SupplierContractError('MALFORMED');
    }
  }
}
