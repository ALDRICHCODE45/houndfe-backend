/**
 * pdf-a4-redesign T6 (S4) — per-tenant consecutive cash-closing folio.
 *
 * Unit level over the shared in-memory fake: the format, the per-tenant
 * independence and the increment. The cross-connection uniqueness under
 * concurrency is proven over PostgreSQL in
 * `prisma-cash-register.closing-folio.integration.spec.ts`.
 */
import { allocateClosingFolio, formatClosingFolio } from './cash-adapter-folio';
import { makeTenantHarness } from './cash-adapter.test-support';

describe('formatClosingFolio', () => {
  it.each([
    [1, 'CC-000001'],
    [124, 'CC-000124'],
    [999999, 'CC-999999'],
  ])('Given %i, then it is zero padded to six digits (%s)', (n, folio) => {
    expect(formatClosingFolio(n)).toBe(folio);
  });

  it('Given a number past 999999, then the folio grows without truncation', () => {
    expect(formatClosingFolio(1000000)).toBe('CC-1000000');
    expect(formatClosingFolio(12345678)).toBe('CC-12345678');
  });
});

describe('allocateClosingFolio', () => {
  it('Given a tenant without a counter, then the first folio is CC-000001', async () => {
    const { host, tenantPrisma } = makeTenantHarness();

    await expect(
      allocateClosingFolio(tenantPrisma.getClient(), host.tenantId),
    ).resolves.toBe('CC-000001');
  });

  it('Given repeated closings in one tenant, then each folio is the next consecutive number', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();

    const folios = [
      await allocateClosingFolio(tx, host.tenantId),
      await allocateClosingFolio(tx, host.tenantId),
      await allocateClosingFolio(tx, host.tenantId),
    ];

    expect(folios).toEqual(['CC-000001', 'CC-000002', 'CC-000003']);
    expect(host.db.folioCounters).toHaveLength(1);
  });

  it('Given two tenants, then each sequence is independent', async () => {
    const { tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();

    expect(await allocateClosingFolio(tx, 'tenant-a')).toBe('CC-000001');
    expect(await allocateClosingFolio(tx, 'tenant-a')).toBe('CC-000002');
    expect(await allocateClosingFolio(tx, 'tenant-b')).toBe('CC-000001');
    expect(await allocateClosingFolio(tx, 'tenant-a')).toBe('CC-000003');
    expect(await allocateClosingFolio(tx, 'tenant-b')).toBe('CC-000002');
  });

  it('Given a counter at 999999, then the next folio is CC-1000000', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    host.db.folioCounters.push({
      id: 'c-1',
      tenantId: host.tenantId,
      lastNumber: 999999,
    });

    await expect(
      allocateClosingFolio(tenantPrisma.getClient(), host.tenantId),
    ).resolves.toBe('CC-1000000');
  });

  it('Given a rolled-back transaction, then the number is not consumed', async () => {
    const { host, tenantPrisma } = makeTenantHarness();
    const tx = tenantPrisma.getClient();

    await expect(
      tenantPrisma.runInTransaction(async () => {
        await allocateClosingFolio(tx, host.tenantId);
        throw new Error('close failed');
      }),
    ).rejects.toThrow('close failed');

    expect(await allocateClosingFolio(tx, host.tenantId)).toBe('CC-000001');
  });
});
