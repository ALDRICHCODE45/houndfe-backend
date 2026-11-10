/**
 * human-intervention / T1 (R5, guard part) — ActiveUserGuard.
 *
 * Access tokens live 15 min and `JwtStrategy` only copies signed claims, so
 * every staff route re-checks the current `User.isActive` and the tenant
 * membership on each request, failing closed. The human-decision reviewer
 * guard keeps its narrower contract (isActive only), pinned below so its
 * routes do not change behavior.
 */
import {
  ExecutionContext,
  ForbiddenException,
  UnauthorizedException,
} from '@nestjs/common';
import type { AuthenticatedUser } from '../interfaces/jwt-payload.interface';
import type { PrismaService } from '../../shared/prisma/prisma.service';
import { HumanDecisionActiveReviewerGuard } from '../../human-decisions/presentation/guards/human-decision-active-reviewer.guard';
import { ActiveUserGuard } from './active-user.guard';

const USER: AuthenticatedUser = {
  userId: 'user-1',
  email: 'staff@houndfe.com',
  tenantId: 'tenant-1',
  tenantSlug: 'centro',
  isSuperAdmin: false,
};

function contextFor(user: AuthenticatedUser | undefined): ExecutionContext {
  return {
    switchToHttp: () => ({ getRequest: () => ({ user }) }),
  } as unknown as ExecutionContext;
}

type Row = { isActive: boolean; tenantMemberships?: { id: string }[] } | null;

function prismaReturning(row: Row) {
  const findUnique = jest.fn().mockResolvedValue(row);
  return {
    findUnique,
    prisma: { user: { findUnique } } as unknown as PrismaService,
  };
}

describe('ActiveUserGuard', () => {
  it('lets an active member of the current tenant through with one query', async () => {
    const { prisma, findUnique } = prismaReturning({
      isActive: true,
      tenantMemberships: [{ id: 'm-1' }],
    });

    await expect(
      new ActiveUserGuard(prisma).canActivate(contextFor(USER)),
    ).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledTimes(1);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: {
        isActive: true,
        tenantMemberships: {
          where: { tenantId: 'tenant-1' },
          select: { id: true },
          take: 1,
        },
      },
    });
  });

  it('rejects an inactive user with 401', async () => {
    const { prisma } = prismaReturning({
      isActive: false,
      tenantMemberships: [{ id: 'm-1' }],
    });

    await expect(
      new ActiveUserGuard(prisma).canActivate(contextFor(USER)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects a deleted user with 401', async () => {
    const { prisma } = prismaReturning(null);

    await expect(
      new ActiveUserGuard(prisma).canActivate(contextFor(USER)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('rejects an active user without membership in the current tenant with 403', async () => {
    const { prisma } = prismaReturning({
      isActive: true,
      tenantMemberships: [],
    });

    await expect(
      new ActiveUserGuard(prisma).canActivate(contextFor(USER)),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a super admin acting in a tenant without membership with 403', async () => {
    const { prisma } = prismaReturning({
      isActive: true,
      tenantMemberships: [],
    });

    await expect(
      new ActiveUserGuard(prisma).canActivate(
        contextFor({ ...USER, isSuperAdmin: true }),
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects a missing principal with 401 and a tenantless one with 403, before any query', async () => {
    const { prisma, findUnique } = prismaReturning({ isActive: true });
    const guard = new ActiveUserGuard(prisma);

    await expect(
      guard.canActivate(contextFor(undefined)),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      guard.canActivate(contextFor({ ...USER, userId: ' ' })),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      guard.canActivate(contextFor({ ...USER, tenantId: null })),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(findUnique).not.toHaveBeenCalled();
  });

  it('fails closed when the lookup throws', async () => {
    const findUnique = jest.fn().mockRejectedValue(new Error('db down'));
    const prisma = { user: { findUnique } } as unknown as PrismaService;

    await expect(
      new ActiveUserGuard(prisma).canActivate(contextFor(USER)),
    ).rejects.toThrow('db down');
  });
});

describe('HumanDecisionActiveReviewerGuard — unchanged contract', () => {
  it('is an ActiveUserGuard', () => {
    const { prisma } = prismaReturning(null);
    expect(new HumanDecisionActiveReviewerGuard(prisma)).toBeInstanceOf(
      ActiveUserGuard,
    );
  });

  it('still selects only isActive (no membership lookup)', async () => {
    const { prisma, findUnique } = prismaReturning({ isActive: true });

    await expect(
      new HumanDecisionActiveReviewerGuard(prisma).canActivate(
        contextFor(USER),
      ),
    ).resolves.toBe(true);
    expect(findUnique).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { isActive: true },
    });
  });

  it('still rejects an inactive reviewer with 401 and a tenantless one with 403', async () => {
    const { prisma } = prismaReturning({ isActive: false });
    const guard = new HumanDecisionActiveReviewerGuard(prisma);

    await expect(guard.canActivate(contextFor(USER))).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      guard.canActivate(contextFor({ ...USER, tenantId: '' })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });
});
