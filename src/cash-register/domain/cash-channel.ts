/**
 * DOMAIN POLICY: cash-register channels (T1/S7).
 *
 * Channel identity is what a count line references and what the closing
 * snapshot groups by:
 *   - Physical CASH is always one pooled drawer total (`CASH`).
 *   - Non-cash keeps the tenant catalog identity (`PM:<paymentMethodId>`)
 *     with a label snapshot, falling back to the base method
 *     (`METHOD:<method>`) when no catalog row is bound.
 *
 * Labels are copied at resolution time so a later catalog rename never
 * rewrites an operation already recorded.
 */
import { addCents } from './cash-money';
import { CASH_RULE_CODES, cashRuleViolation } from './cash-register.errors';
import type {
  CashChannel,
  CashMethod,
  CashMovement,
} from './cash-register.types';
import { assertValidCashMovement } from './cash-movement.policy';

export const CASH_METHOD_LABELS: Readonly<Record<CashMethod, string>> = {
  CASH: 'Efectivo',
  CARD_CREDIT: 'Tarjeta de crédito',
  CARD_DEBIT: 'Tarjeta de débito',
  TRANSFER: 'Transferencia',
};

export const POOLED_CASH_CHANNEL: CashChannel = {
  channelKey: 'CASH',
  channelLabel: CASH_METHOD_LABELS.CASH,
  method: 'CASH',
};

export interface CashCatalogIdentity {
  readonly paymentMethodId: string;
  readonly name: string;
}

export interface ResolveCashChannelInput {
  readonly method: CashMethod;
  readonly catalog?: CashCatalogIdentity | null;
}

/** Resolve the immutable channel snapshot for one movement. */
export function resolveCashChannel(
  input: ResolveCashChannelInput,
): CashChannel {
  if (input.method === 'CASH') {
    return { ...POOLED_CASH_CHANNEL };
  }
  const catalog = input.catalog;
  if (catalog) {
    const paymentMethodId = catalog.paymentMethodId.trim();
    const name = catalog.name.trim();
    if (paymentMethodId.length === 0 || name.length === 0) {
      throw cashRuleViolation(
        CASH_RULE_CODES.CATALOG_IDENTITY_INVALID,
        'catalog channel identity requires a non-empty id and name',
        {
          paymentMethodId: catalog.paymentMethodId,
          name: catalog.name,
        },
      );
    }
    return {
      channelKey: `PM:${paymentMethodId}`,
      channelLabel: name,
      method: input.method,
    };
  }
  return {
    channelKey: `METHOD:${input.method}`,
    channelLabel: CASH_METHOD_LABELS[input.method],
    method: input.method,
  };
}

export function isPhysicalCashChannel(channel: CashChannel): boolean {
  return channel.method === 'CASH';
}

export interface CashChannelTotal {
  readonly channelKey: string;
  readonly channelLabel: string;
  readonly method: CashMethod;
  readonly totalCents: number;
  readonly movementCount: number;
}

function compareChannelKeys(left: string, right: string): number {
  const leftRank = left === POOLED_CASH_CHANNEL.channelKey ? 0 : 1;
  const rightRank = right === POOLED_CASH_CHANNEL.channelKey ? 0 : 1;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return left.localeCompare(right);
}

/**
 * Deterministically group movements by channel: CASH first, then non-cash
 * keys ascending. A shared key with a conflicting label or method means the
 * ledger is not deterministic — fail closed instead of guessing.
 */
export function groupMovementsByChannel(
  movements: readonly CashMovement[],
): readonly CashChannelTotal[] {
  const byKey = new Map<string, CashChannelTotal>();
  for (const movement of movements) {
    assertValidCashMovement(movement);
    const existing = byKey.get(movement.channelKey);
    if (existing) {
      if (
        existing.channelLabel !== movement.channelLabel ||
        existing.method !== movement.method
      ) {
        throw cashRuleViolation(
          CASH_RULE_CODES.CHANNEL_LABEL_CONFLICT,
          'channel key is bound to more than one label or method',
          { channelKey: movement.channelKey },
        );
      }
      byKey.set(movement.channelKey, {
        ...existing,
        totalCents: addCents(
          existing.totalCents,
          movement.deltaCents,
          'channelTotalCents',
        ),
        movementCount: existing.movementCount + 1,
      });
      continue;
    }
    byKey.set(movement.channelKey, {
      channelKey: movement.channelKey,
      channelLabel: movement.channelLabel,
      method: movement.method,
      totalCents: movement.deltaCents,
      movementCount: 1,
    });
  }
  return [...byKey.values()].sort((a, b) =>
    compareChannelKeys(a.channelKey, b.channelKey),
  );
}

export { compareChannelKeys };
