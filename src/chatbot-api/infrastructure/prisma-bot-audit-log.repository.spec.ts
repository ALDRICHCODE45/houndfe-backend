import { Prisma } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { PrismaBotAuditLogRepository } from './prisma-bot-audit-log.repository';

type PrismaServiceMock = {
  botAuditLog: {
    create: jest.Mock<Promise<void>, [unknown]>;
  };
};

function makePrismaServiceMock(): PrismaServiceMock {
  return {
    botAuditLog: {
      create: jest.fn<Promise<void>, [unknown]>(),
    },
  };
}

describe('PrismaBotAuditLogRepository', () => {
  it('appends a bot audit row with the provided payload', async () => {
    const prisma = makePrismaServiceMock();
    prisma.botAuditLog.create.mockResolvedValue(undefined);

    const repository = new PrismaBotAuditLogRepository(
      prisma as unknown as PrismaService,
    );
    const metadata: Prisma.JsonObject = {
      branchId: 'tenant-1',
      outcome: 'success',
    };

    await repository.append({
      tenantId: 'tenant-1',
      credentialId: 'cred-1',
      action: 'sales.register',
      resourceType: 'sale',
      resourceId: 'sale-1',
      metadata,
    });

    expect(prisma.botAuditLog.create).toHaveBeenCalledWith({
      data: {
        tenantId: 'tenant-1',
        credentialId: 'cred-1',
        action: 'sales.register',
        resourceType: 'sale',
        resourceId: 'sale-1',
        metadata,
      },
    });
  });
});
