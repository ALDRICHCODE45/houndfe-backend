import { Injectable } from '@nestjs/common';
import { type ServiceCredential as PrismaServiceCredential } from '@prisma/client';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { ServiceCredential } from '../domain/service-credential.entity';
import type { IServiceCredentialRepository } from '../domain/service-credential.repository';

@Injectable()
export class PrismaServiceCredentialRepository implements IServiceCredentialRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findByHashedKey(hashedKey: string): Promise<ServiceCredential | null> {
    const data = await this.prisma.serviceCredential.findUnique({
      where: { hashedKey },
    });

    return data ? this.toDomain(data) : null;
  }

  async touchLastUsedAt(
    id: string,
    touchedAt: Date = new Date(),
  ): Promise<void> {
    await this.prisma.serviceCredential.update({
      where: { id },
      data: { lastUsedAt: touchedAt },
    });
  }

  private toDomain(data: PrismaServiceCredential): ServiceCredential {
    return ServiceCredential.fromPersistence({
      id: data.id,
      tenantId: data.tenantId,
      name: data.name,
      hashedKey: data.hashedKey,
      scopes: data.scopes,
      isActive: data.isActive,
      lastUsedAt: data.lastUsedAt,
      rateLimit: data.rateLimit,
      createdAt: data.createdAt,
      revokedAt: data.revokedAt,
    });
  }
}
