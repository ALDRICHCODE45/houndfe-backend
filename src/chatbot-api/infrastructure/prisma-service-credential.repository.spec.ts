import type { ServiceCredential as PrismaServiceCredential } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { PrismaServiceCredentialRepository } from './prisma-service-credential.repository';

type PrismaServiceMock = {
  serviceCredential: {
    findUnique: jest.Mock<Promise<PrismaServiceCredential | null>, [unknown]>;
    update: jest.Mock<Promise<void>, [unknown]>;
  };
};

function makePrismaServiceMock(): PrismaServiceMock {
  return {
    serviceCredential: {
      findUnique: jest.fn<Promise<PrismaServiceCredential | null>, [unknown]>(),
      update: jest.fn<Promise<void>, [unknown]>(),
    },
  };
}

describe('PrismaServiceCredentialRepository', () => {
  it('returns a domain credential when the hashed key exists', async () => {
    const prisma = makePrismaServiceMock();
    prisma.serviceCredential.findUnique.mockResolvedValue({
      id: 'cred-1',
      tenantId: 'tenant-1',
      name: 'Chatbot',
      hashedKey: 'hash-123',
      scopes: ['catalog:read'],
      isActive: true,
      lastUsedAt: null,
      rateLimit: 60,
      createdAt: new Date('2026-06-10T10:00:00.000Z'),
      revokedAt: null,
    });

    const repository = new PrismaServiceCredentialRepository(
      prisma as unknown as PrismaService,
    );
    const credential = await repository.findByHashedKey('hash-123');

    expect(prisma.serviceCredential.findUnique).toHaveBeenCalledWith({
      where: { hashedKey: 'hash-123' },
    });
    expect(credential?.tenantId).toBe('tenant-1');
    expect(credential?.hasScope('catalog:read')).toBe(true);
  });

  it('returns null when the hashed key does not exist', async () => {
    const prisma = makePrismaServiceMock();
    prisma.serviceCredential.findUnique.mockResolvedValue(null);

    const repository = new PrismaServiceCredentialRepository(
      prisma as unknown as PrismaService,
    );

    await expect(
      repository.findByHashedKey('missing-hash'),
    ).resolves.toBeNull();
  });

  it('updates the last-used timestamp for an existing credential', async () => {
    const prisma = makePrismaServiceMock();
    prisma.serviceCredential.update.mockResolvedValue(undefined);
    const touchedAt = new Date('2026-06-10T12:00:00.000Z');

    const repository = new PrismaServiceCredentialRepository(
      prisma as unknown as PrismaService,
    );
    await repository.touchLastUsedAt('cred-1', touchedAt);

    expect(prisma.serviceCredential.update).toHaveBeenCalledWith({
      where: { id: 'cred-1' },
      data: { lastUsedAt: touchedAt },
    });
  });
});
