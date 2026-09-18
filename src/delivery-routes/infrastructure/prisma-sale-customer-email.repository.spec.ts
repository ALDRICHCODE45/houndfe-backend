/**
 * ADAPTER UNIT SPEC: PrismaSaleCustomerEmailRepository.findEmailBySaleId —
 * delivery-routes / ODD O1.
 *
 * The send-time authoritative email lookup is the last seam before the
 * Inngest `delivery-next-stop-notify` handler dispatches to a customer
 * address, so the spec proves two independent things:
 *
 *   1. STRUCTURAL — the exact Prisma query: the top-level sale predicate
 *      stays `{ id, tenantId }` and the nested customer projection asks
 *      for `tenantId` beside `email`.
 *   2. BEHAVIORAL — a foreign customer owned by another tenant resolves
 *      to `null`, while a same-tenant customer keeps the existing
 *      trimming / null / blank / non-string behavior.
 *
 * The in-memory Prisma double is PROJECTION-DRIVEN: it materializes only
 * the fields the adapter actually selected. A mock that always returned
 * `{ tenantId, email }` would keep the foreign-tenant spec green even
 * after the nested `tenantId` projection was deleted, hiding a real
 * regression. Because the double honors the projection, dropping
 * `tenantId` fails the same-tenant case too; the structural assertion
 * documents the same seam from the query side.
 *
 * Scope note: this proves source-level, in-memory behavior only. No
 * PostgreSQL row-level filtering, FK behavior, HTTP path, or real email
 * delivery is exercised or claimed here; `pnpm test` never reaches a
 * database.
 */
import { PrismaSaleCustomerEmailRepository } from './prisma-sale-customer-email.repository';
import type { PrismaService } from '../../shared/prisma/prisma.service';

const TENANT_ID = 'tenant-1';
const OTHER_TENANT_ID = 'tenant-2';
const SALE_ID = 'sale-1';

// ── Prisma double types ────────────────────────────────────────────────

/** Nested customer row as stored in the double's in-memory "table". */
type CustomerRow = {
  tenantId: string;
  email: string | null;
};

/** Sale row the double can match. Mirrors `Sale.customer?` (optional). */
type SaleRow = {
  id: string;
  tenantId: string;
  customer: CustomerRow | null;
};

type CustomerSelect = Record<string, true>;

type SaleFindFirstArgs = {
  where?: { id?: string; tenantId?: string };
  select?: { customer?: { select?: CustomerSelect } };
};

// ── Projection-driven Prisma double ────────────────────────────────────

/**
 * Resolve the nested to-one relation while honoring the requested
 * projection: a field the adapter did not select is NEVER present in the
 * returned row, exactly like a real Prisma `select`.
 */
function resolveRow(
  sales: readonly SaleRow[],
  args: SaleFindFirstArgs,
): Record<string, unknown> | null {
  const where = args.where ?? {};
  const match = sales.find(
    (sale) => sale.id === where.id && sale.tenantId === where.tenantId,
  );
  if (!match) {
    return null;
  }

  const customerSelect = args.select?.customer?.select;
  if (!customerSelect) {
    // The relation was not requested — Prisma omits the key entirely.
    return {};
  }
  if (match.customer === null) {
    return { customer: null };
  }

  const projected: Record<string, unknown> = {};
  if (customerSelect.tenantId) {
    projected.tenantId = match.customer.tenantId;
  }
  if (customerSelect.email) {
    projected.email = match.customer.email;
  }
  return { customer: projected };
}

function createPrismaDouble(sales: readonly SaleRow[]) {
  const saleFindFirst = jest.fn(
    async (args: SaleFindFirstArgs): Promise<unknown> =>
      resolveRow(sales, args),
  );

  const prisma = {
    sale: { findFirst: saleFindFirst },
  } as unknown as PrismaService;

  return { prisma, saleFindFirst };
}

function saleWithCustomer(customer: CustomerRow | null): SaleRow {
  return { id: SALE_ID, tenantId: TENANT_ID, customer };
}

// ── Specs ──────────────────────────────────────────────────────────────

describe('PrismaSaleCustomerEmailRepository.findEmailBySaleId', () => {
  /**
   * The preserved invalid-input guard is falsy-based (`!input.tenantId ||
   * !input.saleId`), so only the empty string is the recorded contract;
   * whitespace-only ids are intentionally outside it.
   */
  it.each([
    ['tenantId', { tenantId: '', saleId: SALE_ID }],
    ['saleId', { tenantId: TENANT_ID, saleId: '' }],
  ])(
    'short-circuits an empty %s without querying Prisma',
    async (_field, input) => {
      const { prisma, saleFindFirst } = createPrismaDouble([
        saleWithCustomer({ tenantId: TENANT_ID, email: 'ana@example.com' }),
      ]);
      const repository = new PrismaSaleCustomerEmailRepository(prisma);

      await expect(repository.findEmailBySaleId(input)).resolves.toBeNull();
      expect(saleFindFirst).not.toHaveBeenCalled();
    },
  );

  it('queries the exact tenant-scoped sale predicate and nested tenant projection, and returns the email', async () => {
    const { prisma, saleFindFirst } = createPrismaDouble([
      saleWithCustomer({ tenantId: TENANT_ID, email: 'ana@example.com' }),
    ]);
    const repository = new PrismaSaleCustomerEmailRepository(prisma);

    await expect(
      repository.findEmailBySaleId({ tenantId: TENANT_ID, saleId: SALE_ID }),
    ).resolves.toBe('ana@example.com');

    expect(saleFindFirst).toHaveBeenCalledTimes(1);
    expect(saleFindFirst).toHaveBeenCalledWith({
      where: { id: SALE_ID, tenantId: TENANT_ID },
      select: { customer: { select: { tenantId: true, email: true } } },
    });
    // Redundant but explicit: the nested projection must not grow beyond
    // the tenant discriminator plus the address, so a future edit cannot
    // widen the read unnoticed.
    const customerSelect =
      saleFindFirst.mock.calls[0][0].select?.customer?.select ?? {};
    expect(Object.keys(customerSelect).sort()).toEqual(['email', 'tenantId']);
  });

  it('returns null for a customer owned by another tenant instead of the foreign address', async () => {
    const { prisma, saleFindFirst } = createPrismaDouble([
      saleWithCustomer({
        tenantId: OTHER_TENANT_ID,
        email: 'foreign@example.com',
      }),
    ]);
    const repository = new PrismaSaleCustomerEmailRepository(prisma);

    await expect(
      repository.findEmailBySaleId({ tenantId: TENANT_ID, saleId: SALE_ID }),
    ).resolves.toBeNull();

    // The tenant discriminator was requested, so the null comes from the
    // ownership guard — not from a gap in the projection.
    expect(saleFindFirst.mock.calls[0][0].select?.customer?.select).toEqual({
      tenantId: true,
      email: true,
    });
  });

  it('trims a padded same-tenant email before returning it', async () => {
    const { prisma } = createPrismaDouble([
      saleWithCustomer({ tenantId: TENANT_ID, email: '  ana@example.com\t' }),
    ]);
    const repository = new PrismaSaleCustomerEmailRepository(prisma);

    await expect(
      repository.findEmailBySaleId({ tenantId: TENANT_ID, saleId: SALE_ID }),
    ).resolves.toBe('ana@example.com');
  });

  it.each([
    { name: 'a missing sale', sales: [] as SaleRow[] },
    {
      name: 'a sale without a customer',
      sales: [saleWithCustomer(null)],
    },
    {
      name: 'a null customer email',
      sales: [saleWithCustomer({ tenantId: TENANT_ID, email: null })],
    },
    {
      name: 'a whitespace-only customer email',
      sales: [saleWithCustomer({ tenantId: TENANT_ID, email: ' \n\t ' })],
    },
    {
      name: 'a non-string customer email',
      sales: [
        saleWithCustomer({
          tenantId: TENANT_ID,
          email: 42 as unknown as string,
        }),
      ],
    },
  ])('returns null for $name', async ({ sales }) => {
    const { prisma, saleFindFirst } = createPrismaDouble(sales);
    const repository = new PrismaSaleCustomerEmailRepository(prisma);

    await expect(
      repository.findEmailBySaleId({ tenantId: TENANT_ID, saleId: SALE_ID }),
    ).resolves.toBeNull();

    // The top-level tenant predicate must still be sent for every
    // miss-path read, including the missing-sale case.
    expect(saleFindFirst).toHaveBeenCalledWith({
      where: { id: SALE_ID, tenantId: TENANT_ID },
      select: { customer: { select: { tenantId: true, email: true } } },
    });
  });

  describe('in-memory double faithfulness', () => {
    it('surfaces only the fields the caller selected, so a dropped tenant projection cannot be masked', async () => {
      const { prisma, saleFindFirst } = createPrismaDouble([
        saleWithCustomer({ tenantId: TENANT_ID, email: 'ana@example.com' }),
      ]);

      const rowWithoutTenant = (await saleFindFirst({
        where: { id: SALE_ID, tenantId: TENANT_ID },
        select: { customer: { select: { email: true } } },
      })) as { customer: Record<string, unknown> };

      expect(rowWithoutTenant.customer).toEqual({ email: 'ana@example.com' });
      expect(rowWithoutTenant.customer).not.toHaveProperty('tenantId');
      expect(prisma).toBeDefined();
    });
  });
});
