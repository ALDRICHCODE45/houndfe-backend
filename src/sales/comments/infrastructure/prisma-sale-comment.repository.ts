import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../../shared/prisma/tenant-prisma.service';
import {
  ISaleCommentRepository,
} from '../domain/sale-comment.repository';
import { SaleComment } from '../domain/sale-comment.entity';

@Injectable()
export class PrismaSaleCommentRepository implements ISaleCommentRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async findById(id: string): Promise<SaleComment | null> {
    const comment = await this.tenantPrisma.getClient().saleComment.findUnique({
      where: { id },
    });

    if (!comment) {
      return null;
    }

    return SaleComment.fromPersistence({
      id: comment.id,
      saleId: comment.saleId,
      tenantId: comment.tenantId,
      authorUserId: comment.authorUserId,
      body: comment.body,
      createdAt: comment.createdAt,
      updatedAt: comment.updatedAt,
      deletedAt: comment.deletedAt,
    });
  }

  async findActiveBySale(saleId: string): Promise<SaleComment[]> {
    const rows = await this.tenantPrisma.getClient().saleComment.findMany({
      where: { saleId, deletedAt: null },
      orderBy: { createdAt: 'asc' },
    });

    return rows.map((comment) =>
      SaleComment.fromPersistence({
        id: comment.id,
        saleId: comment.saleId,
        tenantId: comment.tenantId,
        authorUserId: comment.authorUserId,
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        deletedAt: comment.deletedAt,
      }),
    );
  }

  async save(comment: SaleComment): Promise<SaleComment> {
    const prisma = this.tenantPrisma.getClient();

    await prisma.saleComment.upsert({
      where: { id: comment.id },
      create: {
        id: comment.id,
        saleId: comment.saleId,
        tenantId: comment.tenantId,
        authorUserId: comment.authorUserId,
        body: comment.body,
        createdAt: comment.createdAt,
        updatedAt: comment.updatedAt,
        deletedAt: comment.deletedAt,
      },
      update: {
        body: comment.body,
        updatedAt: comment.updatedAt,
        deletedAt: comment.deletedAt,
      },
    });

    return comment;
  }

  async softDelete(id: string, deletedAt: Date): Promise<void> {
    await this.tenantPrisma.getClient().saleComment.update({
      where: { id },
      data: {
        deletedAt,
        updatedAt: deletedAt,
      },
    });
  }
}
