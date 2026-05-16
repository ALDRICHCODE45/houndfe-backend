import { Inject, Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  ISaleCommentRepository,
  SALE_COMMENT_REPOSITORY,
} from './domain/sale-comment.repository';
import { SaleComment } from './domain/sale-comment.entity';
import {
  CommentAuthorForbiddenError,
  SaleCommentNotFoundError,
} from './domain/sale-comment.errors';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import { CreateSaleCommentDto } from './dto/create-sale-comment.dto';
import { UpdateSaleCommentDto } from './dto/update-sale-comment.dto';

@Injectable()
export class SaleCommentsService {
  constructor(
    @Inject(SALE_COMMENT_REPOSITORY)
    private readonly commentsRepository: ISaleCommentRepository,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  async create(
    saleId: string,
    authorUserId: string,
    dto: CreateSaleCommentDto,
  ): Promise<SaleComment> {
    await this.ensureSaleExists(saleId);

    const tenantId = this.tenantPrisma.getTenantId();
    if (!tenantId) {
      throw new BusinessRuleViolationError(
        'TENANT_CONTEXT_REQUIRED',
        'TENANT_CONTEXT_REQUIRED',
      );
    }

    const comment = SaleComment.create({
      saleId,
      tenantId,
      authorUserId,
      body: dto.body,
    });

    return this.commentsRepository.save(comment);
  }

  async update(
    saleId: string,
    commentId: string,
    authorUserId: string,
    dto: UpdateSaleCommentDto,
  ): Promise<SaleComment> {
    const comment = await this.commentsRepository.findById(commentId);
    if (!comment || comment.saleId !== saleId || comment.deletedAt !== null) {
      throw new SaleCommentNotFoundError(commentId);
    }

    comment.updateBody(authorUserId, dto.body);
    return this.commentsRepository.save(comment);
  }

  async softDelete(
    saleId: string,
    commentId: string,
    authorUserId: string,
  ): Promise<void> {
    const comment = await this.commentsRepository.findById(commentId);
    if (!comment || comment.saleId !== saleId || comment.deletedAt !== null) {
      throw new SaleCommentNotFoundError(commentId);
    }

    if (comment.authorUserId !== authorUserId) {
      throw new CommentAuthorForbiddenError();
    }
    comment.softDelete();
    await this.commentsRepository.save(comment);
  }

  private async ensureSaleExists(saleId: string): Promise<void> {
    const sale = await this.tenantPrisma.getClient().sale.findUnique({
      where: { id: saleId },
      select: { id: true },
    });

    if (!sale) {
      throw new BusinessRuleViolationError('SALE_NOT_FOUND', 'SALE_NOT_FOUND');
    }
  }
}
