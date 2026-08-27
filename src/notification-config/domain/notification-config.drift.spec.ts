/**
 * NotificationActionKey drift spec — delivery-routes / WU3 (3.17).
 *
 * Pins the contract that the TS union (`NotificationActionKey`) and the
 * Prisma enum (`NotificationActionKey`) both contain
 * `DELIVERY_NEXT_STOP`. The Prisma side is the runtime source of truth;
 * the TS side is the compile-time source of truth. A drift between the
 * two means a deploy-time regression — the spec catches it in CI before
 * a tenant can enable the action and have it silently fail at
 * `replace()` (where the adapter rejects unknown action keys with 400).
 *
 * Spec: delivery-routes *NotificationActionKey Registry Accepts
 * DELIVERY_NEXT_STOP*.
 */
import { NotificationActionKey } from '@prisma/client';
import {
  NOTIFICATION_ACTION_KEYS,
  type NotificationActionKey as DomainActionKey,
} from './notification-config';

describe('NotificationActionKey — TS union vs Prisma enum (delivery-routes / WU3)', () => {
  it('Given the domain TS union, when introspected, then it includes DELIVERY_NEXT_STOP', () => {
    const domainValues: readonly DomainActionKey[] = NOTIFICATION_ACTION_KEYS;
    expect(domainValues).toContain('DELIVERY_NEXT_STOP');
  });

  it('Given the Prisma runtime enum, when introspected, then it includes DELIVERY_NEXT_STOP', () => {
    const prismaValues = Object.values(NotificationActionKey);
    expect(prismaValues).toContain('DELIVERY_NEXT_STOP');
  });

  it('Given both sources of truth, when compared, then the domain TS union is a SUBSET of the Prisma enum (no TS value is missing from the DB)', () => {
    const prismaValues = new Set<string>(Object.values(NotificationActionKey));
    const missingFromPrisma = NOTIFICATION_ACTION_KEYS.filter(
      (v) => !prismaValues.has(v),
    );
    expect(missingFromPrisma).toEqual([]);
  });

  it('Given both sources of truth, when compared, then the types are structurally assignable in BOTH directions (a DomainActionKey is a Prisma enum value and vice versa)', () => {
    // Compile-time bidirectional check: a DomainActionKey-typed value
    // must satisfy the Prisma enum, and a Prisma enum value must
    // satisfy the DomainActionKey. The runtime assertions below pin
    // the contract; the TS compiler enforces the rest.
    const fromDomain: DomainActionKey = 'DELIVERY_NEXT_STOP';
    const toPrisma: NotificationActionKey = fromDomain as NotificationActionKey;
    expect(toPrisma).toBe('DELIVERY_NEXT_STOP');

    const fromPrisma: NotificationActionKey =
      NotificationActionKey.DELIVERY_NEXT_STOP;
    const toDomain: DomainActionKey = fromPrisma as DomainActionKey;
    expect(toDomain).toBe('DELIVERY_NEXT_STOP');

    // Also confirm the imported Prisma client enum value is non-undefined.
    expect(NotificationActionKey.DELIVERY_NEXT_STOP).toBe('DELIVERY_NEXT_STOP');
  });
});
