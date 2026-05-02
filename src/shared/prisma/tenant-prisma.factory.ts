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

const toDelegateName = (model: string) =>
  `${model.charAt(0).toLowerCase()}${model.slice(1)}`;

export function createTenantScopedPrisma(
  base: PrismaClient,
  cls: ClsService<TenantClsStore>,
) {
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
          const delegate = (base as any)[toDelegateName(model)];
          return delegate.findFirst({ ...(args ?? {}), where: { ...(args?.where ?? {}), tenantId } });
        }

        if (operation === 'findUniqueOrThrow') {
          const delegate = (base as any)[toDelegateName(model)];
          return delegate.findFirstOrThrow({
            ...(args ?? {}),
            where: { ...(args?.where ?? {}), tenantId },
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
