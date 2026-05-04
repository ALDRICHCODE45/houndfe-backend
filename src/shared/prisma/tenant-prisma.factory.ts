import { Prisma } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import type { ClsService } from 'nestjs-cls';
import type { TenantClsStore } from '../tenant/tenant-cls-store.interface';
import { TENANT_SCOPED_MODELS } from '../tenant/tenant-scoped-models.constant';

const READ_OPERATIONS = new Set([
  'findMany',
  'findFirst',
  'findFirstOrThrow',
  'count',
  'aggregate',
  'groupBy',
]);

type TenantScopedRecord = { tenantId?: string | null };

export function createTenantScopedPrisma(
  base: PrismaClient,
  cls: ClsService<TenantClsStore>,
) {
  const isTenantRecord = (value: unknown): value is TenantScopedRecord =>
    value !== null && typeof value === 'object' && 'tenantId' in value;

  return base.$extends({
    query: {
      $allOperations({ model, operation, args, query }) {
        if (!model || !TENANT_SCOPED_MODELS.has(model)) {
          return query(args);
        }

        const tenantId = cls.get('tenantId');
        const isSuperAdmin = cls.get('isSuperAdmin');

        if (isSuperAdmin === true && tenantId === null) {
          return query(args);
        }

        if (!tenantId) {
          throw new Error('Tenant context required');
        }

        if (operation === 'findUnique') {
          return query({
            ...(args ?? {}),
            where: { ...(args?.where ?? {}), tenantId },
          });
        }

        if (operation === 'findUniqueOrThrow') {
          return query({
            ...(args ?? {}),
            where: { ...(args?.where ?? {}), tenantId },
          }).then((record) => {
            if (!isTenantRecord(record) || record.tenantId !== tenantId) {
              throw new Prisma.PrismaClientKnownRequestError(
                'No record found for findUniqueOrThrow',
                {
                  clientVersion: Prisma.prismaVersion.client,
                  code: 'P2025',
                },
              );
            }
            return record;
          });
        }

        if (READ_OPERATIONS.has(operation)) {
          return query({
            ...(args ?? {}),
            where: { ...(args?.where ?? {}), tenantId },
          });
        }

        if (operation === 'create') {
          return query({
            ...(args ?? {}),
            data: { ...(args?.data ?? {}), tenantId },
          });
        }

        if (operation === 'createMany') {
          const data = Array.isArray(args?.data)
            ? args.data.map((item: Record<string, unknown>) => ({ ...item, tenantId }))
            : { ...(args?.data ?? {}), tenantId };

          return query({ ...(args ?? {}), data });
        }

        if (operation === 'upsert') {
          return query({
            ...(args ?? {}),
            where: { ...(args?.where ?? {}), tenantId },
            create: { ...(args?.create ?? {}), tenantId },
          });
        }

        if (
          operation === 'update' ||
          operation === 'updateMany' ||
          operation === 'delete' ||
          operation === 'deleteMany'
        ) {
          return query({
            ...(args ?? {}),
            where: { ...(args?.where ?? {}), tenantId },
          });
        }

        return query(args);
      },
    },
  });
}
