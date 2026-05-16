import { randomUUID } from 'crypto';
import { BusinessRuleViolationError } from '../../../shared/domain/domain-error';
import { CommentAuthorForbiddenError } from './sale-comment.errors';

type SaleCommentCreateInput = {
  saleId: string;
  tenantId: string;
  authorUserId: string;
  body: string;
};

type SaleCommentRestoreInput = {
  id: string;
  saleId: string;
  tenantId: string;
  authorUserId: string;
  body: string;
  createdAt: Date;
  updatedAt: Date;
  deletedAt: Date | null;
};

export class SaleComment {
  private constructor(
    private readonly _id: string,
    private readonly _saleId: string,
    private readonly _tenantId: string,
    private readonly _authorUserId: string,
    private _body: string,
    private readonly _createdAt: Date,
    private _updatedAt: Date,
    private _deletedAt: Date | null,
  ) {}

  static create(input: SaleCommentCreateInput): SaleComment {
    const now = new Date();
    return new SaleComment(
      randomUUID(),
      input.saleId,
      input.tenantId,
      input.authorUserId,
      SaleComment.normalizeBody(input.body),
      now,
      now,
      null,
    );
  }

  static fromPersistence(input: SaleCommentRestoreInput): SaleComment {
    return new SaleComment(
      input.id,
      input.saleId,
      input.tenantId,
      input.authorUserId,
      input.body,
      input.createdAt,
      input.updatedAt,
      input.deletedAt,
    );
  }

  updateBody(authorUserId: string, body: string): void {
    if (authorUserId !== this._authorUserId) {
      throw new CommentAuthorForbiddenError();
    }

    this._body = SaleComment.normalizeBody(body);
    this._updatedAt = new Date();
  }

  softDelete(): void {
    const now = new Date();
    this._deletedAt = now;
    this._updatedAt = now;
  }

  private static normalizeBody(body: string): string {
    const normalized = body.trim();
    if (normalized.length < 1 || normalized.length > 2000) {
      throw new BusinessRuleViolationError(
        'INVALID_COMMENT_BODY',
        'INVALID_COMMENT_BODY',
      );
    }
    return normalized;
  }

  get id(): string {
    return this._id;
  }
  get saleId(): string {
    return this._saleId;
  }
  get tenantId(): string {
    return this._tenantId;
  }
  get authorUserId(): string {
    return this._authorUserId;
  }
  get body(): string {
    return this._body;
  }
  get createdAt(): Date {
    return this._createdAt;
  }
  get updatedAt(): Date {
    return this._updatedAt;
  }
  get deletedAt(): Date | null {
    return this._deletedAt;
  }
}
