/**
 * Q1 / WU1 — CASL registry check for `PaymentDetail` subject (mirrors the
 * `Quotation` precedent in `permission-registry-quotation.spec.ts`).
 *
 * Guards that:
 *   - `PaymentDetail` is in the `AppSubjects` union (otherwise
 *     `@RequirePermissions` decorators throw a TS error).
 *   - The exact CRUD action set (`read`, `create`, `update`, `delete`) is
 *     in `PERMISSION_REGISTRY`.
 *   - `batch_delete` / `manage` are intentionally out (Q1 surface doesn't
 *     need them).
 */
import type { AppSubjects } from './permission';
import { PERMISSION_REGISTRY } from './permission';

describe('PERMISSION_REGISTRY — PaymentDetail (Q1 / WU1)', () => {
  it("registers 'PaymentDetail' as an application subject", () => {
    const subject: AppSubjects = 'PaymentDetail';
    expect(subject).toBe('PaymentDetail');
  });

  it('registers read / create / update / delete for PaymentDetail', () => {
    const actions = PERMISSION_REGISTRY.filter(
      (p) => p.subject === 'PaymentDetail',
    ).map((p) => p.action);

    expect(actions).toEqual(
      expect.arrayContaining(['read', 'create', 'update', 'delete']),
    );
    expect(actions).toHaveLength(4);
  });

  it('does NOT register batch_delete or manage for PaymentDetail in Q1', () => {
    const actions = PERMISSION_REGISTRY.filter(
      (p) => p.subject === 'PaymentDetail',
    ).map((p) => p.action);

    expect(actions).not.toContain('batch_delete');
    expect(actions).not.toContain('manage');
  });

  it('all four PaymentDetail descriptions are non-empty', () => {
    const entries = PERMISSION_REGISTRY.filter(
      (p) => p.subject === 'PaymentDetail',
    );
    for (const entry of entries) {
      expect(typeof entry.description).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });
});
