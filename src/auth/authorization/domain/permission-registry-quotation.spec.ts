/**
 * WU2 — CASL registry check for `Quotation` subject (mirrors the
 * `NotificationConfig` precedent in
 * `permission-registry.spec.ts`).
 *
 * Guards that:
 *   - `Quotation` is in the `AppSubjects` union (otherwise
 *     `@RequirePermissions` decorators throw a TS error).
 *   - The exact WU2 action set (`create`, `read`, `update`, `delete`)
 *     is in `PERMISSION_REGISTRY`.
 *   - `batch_delete` / `manage` are intentionally out (WU2 surface
 *     doesn't need them; future WUs that ship them must also update
 *     this spec).
 */
import type { AppSubjects } from './permission';
import { PERMISSION_REGISTRY } from './permission';

describe('PERMISSION_REGISTRY — Quotation (WU2)', () => {
  it("registers 'Quotation' as an application subject", () => {
    const subject: AppSubjects = 'Quotation';
    expect(subject).toBe('Quotation');
  });

  it('registers create / read / update / delete for Quotation', () => {
    const actions = PERMISSION_REGISTRY.filter(
      (p) => p.subject === 'Quotation',
    ).map((p) => p.action);

    expect(actions).toEqual(
      expect.arrayContaining(['create', 'read', 'update', 'delete']),
    );
    expect(actions).toHaveLength(4);
  });

  it('does NOT register batch_delete or manage for Quotation in WU2', () => {
    const actions = PERMISSION_REGISTRY.filter(
      (p) => p.subject === 'Quotation',
    ).map((p) => p.action);

    // WU2 ships only the four CRUD-style actions used by the
    // controller routes (create / read / update / delete). If a
    // future contributor adds `batch_delete` or `manage`, they must
    // widen the controller decorators + the spec simultaneously.
    expect(actions).not.toContain('batch_delete');
    expect(actions).not.toContain('manage');
  });
});
