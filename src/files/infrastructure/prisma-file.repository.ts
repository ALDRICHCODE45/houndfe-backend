/**
 * PrismaFileRepository - Prisma implementation of IFileRepository.
 *
 * Persists FileObject entities using Prisma ORM.
 */
import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { IFileRepository } from '../domain/file.repository';
import { FileObject } from '../domain/file-object.entity';
import { FileNotFoundError } from '../domain/errors';

@Injectable()
export class PrismaFileRepository implements IFileRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async save(file: FileObject): Promise<FileObject> {
    const prisma = this.tenantPrisma.getClient();
    const persisted = await prisma.fileObject.create({
      data: {
        id: file.id,
        storageKey: file.storageKey,
        url: file.url,
        mimeType: file.mimeType,
        sizeBytes: file.sizeBytes,
        ownerType: file.ownerType,
        ownerId: file.ownerId,
        uploadedBy: file.uploadedBy,
        createdAt: file.createdAt,
      },
    });

    return FileObject.create({
      id: persisted.id,
      storageKey: persisted.storageKey,
      url: persisted.url,
      mimeType: persisted.mimeType,
      sizeBytes: persisted.sizeBytes,
      ownerType: persisted.ownerType ?? undefined,
      ownerId: persisted.ownerId ?? undefined,
      uploadedBy: persisted.uploadedBy ?? undefined,
      createdAt: persisted.createdAt,
    });
  }

  async findById(id: string): Promise<FileObject | null> {
    const prisma = this.tenantPrisma.getClient();
    const record = await prisma.fileObject.findUnique({
      where: { id },
    });

    if (!record) {
      return null;
    }

    return FileObject.create({
      id: record.id,
      storageKey: record.storageKey,
      url: record.url,
      mimeType: record.mimeType,
      sizeBytes: record.sizeBytes,
      ownerType: record.ownerType ?? undefined,
      ownerId: record.ownerId ?? undefined,
      uploadedBy: record.uploadedBy ?? undefined,
      createdAt: record.createdAt,
    });
  }

  async findByIds(ids: string[]): Promise<FileObject[]> {
    const prisma = this.tenantPrisma.getClient();
    const records = await prisma.fileObject.findMany({
      where: { id: { in: ids } },
    });

    return records.map((record) =>
      FileObject.create({
        id: record.id,
        storageKey: record.storageKey,
        url: record.url,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        ownerType: record.ownerType ?? undefined,
        ownerId: record.ownerId ?? undefined,
        uploadedBy: record.uploadedBy ?? undefined,
        createdAt: record.createdAt,
      }),
    );
  }

  async delete(id: string): Promise<void> {
    const prisma = this.tenantPrisma.getClient();
    try {
      await prisma.fileObject.delete({
        where: { id },
      });
    } catch (error) {
      if (error.code === 'P2025') {
        throw new FileNotFoundError(id);
      }
      throw error;
    }
  }

  async findByOwner(ownerType: string, ownerId: string): Promise<FileObject[]> {
    const prisma = this.tenantPrisma.getClient();
    const records = await prisma.fileObject.findMany({
      where: {
        ownerType,
        ownerId,
      },
    });

    return records.map((record) =>
      FileObject.create({
        id: record.id,
        storageKey: record.storageKey,
        url: record.url,
        mimeType: record.mimeType,
        sizeBytes: record.sizeBytes,
        ownerType: record.ownerType ?? undefined,
        ownerId: record.ownerId ?? undefined,
        uploadedBy: record.uploadedBy ?? undefined,
        createdAt: record.createdAt,
      }),
    );
  }
}
