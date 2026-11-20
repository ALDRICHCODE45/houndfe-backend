import { Injectable } from '@nestjs/common';
import type {
  BackorderReservedHook,
  ReservedBackorder,
} from '../application/ports/backorder-reserved-hook.port';

/**
 * Binding of `BACKORDER_RESERVED_HOOK` until the feed task (T2b) enqueues
 * `backorder.reserved`: does nothing.
 */
@Injectable()
export class NoOpBackorderReservedHook implements BackorderReservedHook {
  onReserved(tx: unknown, reserved: ReservedBackorder): Promise<void> {
    void tx;
    void reserved;
    return Promise.resolve();
  }
}
