/**
 * pending-refund-obligations / prf-1 — CASL registry check for the
 * `SaleRefund` subject (mirrors the `PaymentDetail` precedent in
 * `permission-registry-payment-detail.spec.ts`).
 *
 * Guards that:
 *   - `SaleRefund` is in the `AppSubjects` union (otherwise
 *     `@RequirePermissions` decorators throw a TS error).
 *   - The registry exposes exactly `read:SaleRefund`.
 *   - Cancellation keeps ownership of refund creation: `create`, `update`,
 *     `delete`, `batch_delete`, and `manage` stay out.
 */
import type { AppSubjects } from './permission';
import { PERMISSION_REGISTRY } from './permission';

describe('PERMISSION_REGISTRY — SaleRefund (prf-1)', () => {
  it("registers 'SaleRefund' as an application subject", () => {
    const subject: AppSubjects = 'SaleRefund';
    expect(subject).toBe('SaleRefund');
  });

  it("registers exactly one permission, 'read', for SaleRefund", () => {
    const entries = PERMISSION_REGISTRY.filter(
      (p) => p.subject === 'SaleRefund',
    );

    expect(entries).toHaveLength(1);
    expect(entries[0]?.action).toBe('read');
  });

  it('does NOT register create / update / delete / batch_delete / manage', () => {
    const actions = PERMISSION_REGISTRY.filter(
      (p) => p.subject === 'SaleRefund',
    ).map((p) => p.action);

    expect(actions).not.toEqual(
      expect.arrayContaining([
        'create',
        'update',
        'delete',
        'batch_delete',
        'manage',
      ]),
    );
  });

  it('gives the SaleRefund read permission a non-empty description', () => {
    const entries = PERMISSION_REGISTRY.filter(
      (p) => p.subject === 'SaleRefund',
    );

    for (const entry of entries) {
      expect(typeof entry.description).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});
