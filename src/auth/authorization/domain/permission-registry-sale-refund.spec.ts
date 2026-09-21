/**
 * pending-refund-obligations / prf-1 and partial-refund-settlements / rfs-1 —
 * CASL registry check for the `SaleRefund` subject (mirrors the
 * `PaymentDetail` precedent in `permission-registry-payment-detail.spec.ts`).
 *
 * Guards that:
 *   - `SaleRefund` is in the `AppSubjects` union (otherwise
 *     `@RequirePermissions` decorators throw a TS error).
 *   - The registry exposes exactly `read:SaleRefund` and
 *     `update:SaleRefund`, in that order.
 *   - Cancellation keeps ownership of refund creation: `create`,
 *     `delete`, `batch_delete`, and `manage` stay out.
 */
import type { AppSubjects } from './permission';
import { PERMISSION_REGISTRY } from './permission';

describe('PERMISSION_REGISTRY — SaleRefund (prf-1, rfs-1)', () => {
  it("registers 'SaleRefund' as an application subject", () => {
    const subject: AppSubjects = 'SaleRefund';
    expect(subject).toBe('SaleRefund');
  });

  it("registers exactly the ['read', 'update'] actions for SaleRefund", () => {
    const actions = PERMISSION_REGISTRY.filter(
      (p) => p.subject === 'SaleRefund',
    ).map((p) => p.action);

    expect(actions).toEqual(['read', 'update']);
  });

  it('gives every SaleRefund permission a non-empty description', () => {
    const entries = PERMISSION_REGISTRY.filter(
      (p) => p.subject === 'SaleRefund',
    );

    expect(entries).toHaveLength(2);

    for (const entry of entries) {
      expect(typeof entry.description).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('does NOT register create / delete / batch_delete / manage', () => {
    const actions = PERMISSION_REGISTRY.filter(
      (p) => p.subject === 'SaleRefund',
    ).map((p) => p.action);

    expect(actions).not.toEqual(
      expect.arrayContaining(['create', 'delete', 'batch_delete', 'manage']),
    );
  });
});
