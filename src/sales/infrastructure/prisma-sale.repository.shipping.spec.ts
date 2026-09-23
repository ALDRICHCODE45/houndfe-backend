import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Prisma } from '@prisma/client';
import { PrismaSaleRepository } from './prisma-sale.repository';
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';

const migrationPath = join(
  process.cwd(),
  'prisma/migrations/20260923210000_bot_sale_shipping_charge/migration.sql',
);

describe('bot sale shipping snapshot persistence', () => {
  const updateMany = jest.fn().mockResolvedValue({ count: 1 });
  const repo = new PrismaSaleRepository({
    getTenantId: () => 'tenant-1',
    getClient: () => ({
      sale: { updateMany },
      salePayment: { create: jest.fn() },
    }),
  } as unknown as TenantPrismaService);
  const baseInput = {
    saleId: 'sale-1',
    userId: 'cashier-1',
    payments: [],
    subtotalCents: 12_000,
    discountCents: 2_000,
    totalCents: 12_500,
    paidCents: 0,
    debtCents: 12_500,
    changeDueCents: 0,
    paymentStatus: 'CREDIT' as const,
    confirmedAt: new Date('2026-09-23T00:00:00.000Z'),
    folio: 'A-202609-000001',
  };

  beforeEach(() => updateMany.mockReset().mockResolvedValue({ count: 1 }));

  it('persists shipping amount and approval/quote identity on the confirmed sale', async () => {
    await repo.persistChargeConfirmation({
      ...baseInput,
      shippingChargeCents: 2_500,
      shippingApprovalId: 'human-approval-1',
      shippingQuoteId: 'quote-1',
    });
    expect(updateMany).toHaveBeenCalledTimes(1);
    const write = (
      updateMany.mock.calls as unknown as [Prisma.SaleUpdateManyArgs][]
    )[0][0];
    expect(write.where).toEqual({ id: 'sale-1', tenantId: 'tenant-1' });
    expect(write.data).toMatchObject({
      shippingChargeCents: 2_500,
      shippingApprovalId: 'human-approval-1',
      shippingQuoteId: 'quote-1',
      totalCents: 12_500,
      debtCents: 12_500,
    });
  });

  it('does not overwrite shipping fields on legacy/POS confirmations', async () => {
    await repo.persistChargeConfirmation(baseInput);
    const write = (
      updateMany.mock.calls as unknown as [Prisma.SaleUpdateManyArgs][]
    )[0][0];
    expect(write.data).not.toHaveProperty('shippingChargeCents');
    expect(write.data).not.toHaveProperty('shippingApprovalId');
  });

  it('maps only approval-identity uniqueness conflicts to a domain conflict', async () => {
    updateMany.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '6.19.2',
        meta: { target: ['tenantId', 'shippingApprovalId'] },
      }),
    );
    await expect(
      repo.persistChargeConfirmation({
        ...baseInput,
        shippingChargeCents: 2_500,
        shippingApprovalId: 'already-used',
      }),
    ).rejects.toMatchObject({ code: 'SHIPPING_APPROVAL_ALREADY_USED' });
  });

  it('does not mislabel an unrelated uniqueness failure as approval reuse', async () => {
    updateMany.mockRejectedValueOnce(
      new Prisma.PrismaClientKnownRequestError('duplicate', {
        code: 'P2002',
        clientVersion: '6.19.2',
        meta: { target: ['folio'] },
      }),
    );
    await expect(
      repo.persistChargeConfirmation({
        ...baseInput,
        shippingChargeCents: 2_500,
        shippingApprovalId: 'unused',
      }),
    ).rejects.toMatchObject({ code: 'P2002' });
  });

  it('migration pins an immutable amount and one approval use per tenant', () => {
    const sql = readFileSync(migrationPath, 'utf8');
    expect(sql).toMatch(
      /ADD COLUMN\s+"shippingChargeCents"\s+INTEGER\s+NOT NULL\s+DEFAULT 0/i,
    );
    expect(sql).toMatch(/ADD COLUMN\s+"shippingApprovalId"\s+TEXT/i);
    expect(sql).toMatch(
      /UNIQUE INDEX[\s\S]+"tenantId"\s*,\s*"shippingApprovalId"/i,
    );
  });
});
