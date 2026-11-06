/**
 * INTEGRATION SPEC: which configured recipients may receive the
 * RECEIPT_REVIEW_REQUESTED email, against the real `nest-practice-test` DB
 * (port 5433 — NEVER dev). Permission rows are global and upserted by their
 * unique (subject, action); everything else hangs off two fixture tenants.
 */
import { randomUUID } from 'node:crypto';
import { PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import { PrismaReceiptReviewerLookup } from './prisma-receipt-reviewer.lookup';

const SKIP_INTEGRATION =
  process.env.SKIP_DB_INTEGRATION === '1' || !process.env.DATABASE_URL;
const describeIfDb = SKIP_INTEGRATION ? describe.skip : describe;

describeIfDb('PrismaReceiptReviewerLookup (Integration)', () => {
  let prisma: PrismaClient;
  let lookup: PrismaReceiptReviewerLookup;
  const tenantId = randomUUID();
  const otherTenantId = randomUUID();
  const users: Record<string, string> = {};

  beforeAll(async () => {
    prisma = new PrismaClient();
    await prisma.$connect();
    const cls = {
      get: (key: string) => {
        if (key === 'tenantId') return tenantId;
        if (key === 'isSuperAdmin') return false;
        return undefined;
      },
    } as unknown as ClsService<TenantClsStore>;
    lookup = new PrismaReceiptReviewerLookup(
      new TenantPrismaService(
        prisma as unknown as ConstructorParameters<
          typeof TenantPrismaService
        >[0],
        cls,
      ),
    );

    for (const id of [tenantId, otherTenantId]) {
      await prisma.tenant.create({
        data: { id, name: 'Reviewers', slug: `rv-${id.slice(0, 8)}` },
      });
    }
    const permission = (subject: string, action: string) =>
      prisma.permission.upsert({
        where: { subject_action: { subject, action } },
        update: {},
        create: { subject, action },
      });
    const update = await permission('ReceiptEvidence', 'update');
    const read = await permission('ReceiptEvidence', 'read');
    const manageAll = await permission('all', 'manage');

    const role = async (tenant: string, permissionIds: string[]) =>
      prisma.role.create({
        data: {
          tenantId: tenant,
          name: `role-${randomUUID()}`,
          permissions: {
            create: permissionIds.map((permissionId) => ({ permissionId })),
          },
        },
      });
    const reviewerRole = await role(tenantId, [update.id]);
    const readerRole = await role(tenantId, [read.id]);
    const adminRole = await role(tenantId, [manageAll.id]);
    const otherTenantReviewerRole = await role(otherTenantId, [update.id]);

    const member = async (
      key: string,
      memberships: Array<{ tenant: string; roleId: string }>,
      isActive = true,
    ) => {
      const id = randomUUID();
      users[key] = id;
      await prisma.user.create({
        data: {
          id,
          email: `${key}-${id.slice(0, 8)}@example.com`,
          hashedPassword: 'x',
          name: key,
          isActive,
        },
      });
      for (const { tenant, roleId } of memberships) {
        await prisma.tenantMembership.create({
          data: { userId: id, tenantId: tenant, roleId },
        });
      }
    };
    await member('reviewer', [{ tenant: tenantId, roleId: reviewerRole.id }]);
    await member('reader', [{ tenant: tenantId, roleId: readerRole.id }]);
    await member('admin', [{ tenant: tenantId, roleId: adminRole.id }]);
    await member(
      'inactive',
      [{ tenant: tenantId, roleId: reviewerRole.id }],
      false,
    );
    await member('elsewhere', [
      { tenant: tenantId, roleId: readerRole.id },
      { tenant: otherTenantId, roleId: otherTenantReviewerRole.id },
    ]);
  });

  afterAll(async () => {
    await prisma.tenant.deleteMany({
      where: { id: { in: [tenantId, otherTenantId] } },
    });
    await prisma.user.deleteMany({
      where: { id: { in: Object.values(users) } },
    });
    await prisma.$disconnect();
  });

  it('keeps only active members whose role in this tenant can review receipts', async () => {
    const emails = await lookup.resolveReviewerEmails(Object.values(users));

    expect(emails.map((email) => email.split('-')[0]).sort()).toEqual([
      'admin',
      'reviewer',
    ]);
  });

  it('answers [] for no user ids', async () => {
    await expect(lookup.resolveReviewerEmails([])).resolves.toEqual([]);
  });
});
