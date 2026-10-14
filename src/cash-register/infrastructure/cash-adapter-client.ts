/**
 * cash-register-closing / S10 — shared transaction-client type.
 *
 * The Prisma client bound to the request tenant. Kept in its own leaf module
 * so the storage, authorization and command modules can name it without
 * importing each other.
 */
import type { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';

export type TenantClient = ReturnType<TenantPrismaService['getClient']>;
