/**
 * ADAPTER UNIT SPEC: PrismaSaleDeliveryStopProvenanceRepository.hasCompletedRouteStop
 * — delivery-routes / DTE-4a.proof.
 *
 * The adapter splits its guarantee across two seams, and this spec pins
 * each at the seam where it actually holds:
 *
 *   - QUERY-driven (asserted on the exact `findFirst` arguments): the
 *     full completed-stop conjunction — exact stop / tenant / route /
 *     sale identity, `status: 'COMPLETED'`, both timestamps non-null,
 *     and the tenant-matching route relation — plus the id-only
 *     projection and the deliberate absence of route status and channel
 *     gating. Prisma evaluates those row-level predicates, so an explicit
 *     argument assertion is the honest proof. A fake that re-implemented
 *     Prisma filtering would only test the fake, and would tempt a false
 *     "live DB" claim, so this file deliberately does NOT build one.
 *   - CODE-driven (asserted on the returned boolean): the blank-identity
 *     short-circuit that must return `false` BEFORE any read, and the
 *     `null` → `false` / row → `true` mapping.
 *
 * The `PrismaService` mock is a plain `jest.fn()` injected through
 * `Test.createTestingModule`, so no `as any` / `as unknown as` cast is
 * needed anywhere in this file.
 *
 * Scope note: source-level, in-memory behavior only. No PostgreSQL
 * row-level filtering, FK behavior, or real send is exercised or claimed
 * here; `pnpm test` never reaches a database.
 */
import { Test } from '@nestjs/testing';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { PrismaSaleDeliveryStopProvenanceRepository } from './prisma-sale-delivery-stop-provenance.repository';

const TENANT_ID = 'tenant-1';
const ROUTE_ID = 'route-1';
const STOP_ID = 'stop-1';
const SALE_ID = 'sale-1';
const INPUT = {
  tenantId: TENANT_ID,
  routeId: ROUTE_ID,
  stopId: STOP_ID,
  saleId: SALE_ID,
};

/** Shape of the single Prisma call this adapter is allowed to make. */
type StopFindFirstArgs = {
  where: Record<string, unknown>;
  select: Record<string, true>;
};

// ── Mock + fixtures ────────────────────────────────────────────────────

async function createRepository() {
  const stopFindFirst = jest.fn<Promise<unknown>, [StopFindFirstArgs]>();
  const moduleRef = await Test.createTestingModule({
    providers: [
      PrismaSaleDeliveryStopProvenanceRepository,
      {
        provide: PrismaService,
        useValue: { deliveryRouteStop: { findFirst: stopFindFirst } },
      },
    ],
  }).compile();
  return {
    provenance: moduleRef.get(PrismaSaleDeliveryStopProvenanceRepository),
    stopFindFirst,
  };
}

// ── Specs ──────────────────────────────────────────────────────────────

describe('PrismaSaleDeliveryStopProvenanceRepository.hasCompletedRouteStop', () => {
  describe('query contract', () => {
    it('proves the exact completed-stop conjunction in one tenant-qualified read', async () => {
      const { provenance, stopFindFirst } = await createRepository();
      stopFindFirst.mockResolvedValue({ id: STOP_ID });

      await expect(provenance.hasCompletedRouteStop(INPUT)).resolves.toBe(true);

      expect(stopFindFirst).toHaveBeenCalledTimes(1);
      expect(stopFindFirst.mock.calls[0][0].where).toEqual({
        id: STOP_ID,
        tenantId: TENANT_ID,
        routeId: ROUTE_ID,
        saleId: SALE_ID,
        status: 'COMPLETED',
        checkedInAt: { not: null },
        completedAt: { not: null },
        route: { tenantId: TENANT_ID },
      });
    });

    it('accepts only the literal COMPLETED status enumeration', async () => {
      const { provenance, stopFindFirst } = await createRepository();
      stopFindFirst.mockResolvedValue({ id: STOP_ID });

      await provenance.hasCompletedRouteStop(INPUT);

      // Not `in: [...]`, not `not: 'SKIPPED'` — the proof is the single
      // positive status, so PENDING / IN_PROGRESS / SKIPPED can never
      // satisfy the predicate.
      const status = stopFindFirst.mock.calls[0][0].where.status;
      expect(status).toBe('COMPLETED');
    });

    it('requires both completion timestamps to be present', async () => {
      const { provenance, stopFindFirst } = await createRepository();
      stopFindFirst.mockResolvedValue({ id: STOP_ID });

      await provenance.hasCompletedRouteStop(INPUT);

      const where = stopFindFirst.mock.calls[0][0].where;
      expect(where.checkedInAt).toEqual({ not: null });
      expect(where.completedAt).toEqual({ not: null });
    });

    it('tenant-qualifies the route relation as well as the stop row', async () => {
      const { provenance, stopFindFirst } = await createRepository();
      stopFindFirst.mockResolvedValue({ id: STOP_ID });

      await provenance.hasCompletedRouteStop(INPUT);

      expect(stopFindFirst.mock.calls[0][0].where.route).toEqual({
        tenantId: TENANT_ID,
      });
    });

    it('selects the stop id only, proving existence without loading the row', async () => {
      const { provenance, stopFindFirst } = await createRepository();
      stopFindFirst.mockResolvedValue({ id: STOP_ID });

      await provenance.hasCompletedRouteStop(INPUT);

      expect(stopFindFirst.mock.calls[0][0].select).toEqual({ id: true });
    });

    it('does not gate on the route lifecycle status (a completed stop survives a cancelled route)', async () => {
      const { provenance, stopFindFirst } = await createRepository();
      stopFindFirst.mockResolvedValue({ id: STOP_ID });

      await provenance.hasCompletedRouteStop(INPUT);

      const where = stopFindFirst.mock.calls[0][0].where;
      expect(where).not.toHaveProperty('route.status');
      expect(where.route).not.toHaveProperty('status');
      expect(JSON.stringify(where.route)).not.toContain('CANCELLED');
    });

    it('does not gate on Sale.channel (channel is not provenance)', async () => {
      const { provenance, stopFindFirst } = await createRepository();
      stopFindFirst.mockResolvedValue({ id: STOP_ID });

      await provenance.hasCompletedRouteStop(INPUT);

      // The adapter reads only `deliveryRouteStop`; a channel predicate
      // would have to arrive as a `sale` relation or a `channel` key.
      const where = stopFindFirst.mock.calls[0][0].where;
      expect(where).not.toHaveProperty('sale');
      expect(where).not.toHaveProperty('channel');
    });
  });

  describe('blank-identity short-circuit', () => {
    it.each([
      ['an empty tenantId', { ...INPUT, tenantId: '' }],
      ['a whitespace-only tenantId', { ...INPUT, tenantId: '   ' }],
      ['an empty routeId', { ...INPUT, routeId: '' }],
      ['a whitespace-only routeId', { ...INPUT, routeId: '   ' }],
      ['an empty stopId', { ...INPUT, stopId: '' }],
      ['a whitespace-only stopId', { ...INPUT, stopId: '   ' }],
      ['an empty saleId', { ...INPUT, saleId: '' }],
      ['a whitespace-only saleId', { ...INPUT, saleId: '   ' }],
    ])(
      'returns false for %s without querying Prisma',
      async (_label, input) => {
        const { provenance, stopFindFirst } = await createRepository();

        await expect(provenance.hasCompletedRouteStop(input)).resolves.toBe(
          false,
        );
        expect(stopFindFirst).not.toHaveBeenCalled();
      },
    );

    it('passes a padded but non-blank id to Prisma verbatim (no silent normalization)', async () => {
      const { provenance, stopFindFirst } = await createRepository();
      stopFindFirst.mockResolvedValue({ id: STOP_ID });

      await provenance.hasCompletedRouteStop({
        ...INPUT,
        stopId: '  stop-1  ',
      });

      expect(stopFindFirst.mock.calls[0][0].where.id).toBe('  stop-1  ');
    });
  });

  describe('result mapping', () => {
    it('returns false when no matching completed stop exists', async () => {
      const { provenance, stopFindFirst } = await createRepository();
      stopFindFirst.mockResolvedValue(null);

      await expect(provenance.hasCompletedRouteStop(INPUT)).resolves.toBe(
        false,
      );
    });

    it('returns true only for a returned matching stop row', async () => {
      const { provenance, stopFindFirst } = await createRepository();
      stopFindFirst.mockResolvedValue({ id: STOP_ID });

      await expect(provenance.hasCompletedRouteStop(INPUT)).resolves.toBe(true);
    });
  });
});
