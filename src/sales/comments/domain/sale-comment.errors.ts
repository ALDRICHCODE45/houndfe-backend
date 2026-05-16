import { BusinessRuleViolationError } from '../../../shared/domain/domain-error';

export class SaleCommentNotFoundError extends BusinessRuleViolationError {
  constructor(commentId: string) {
    super('COMMENT_NOT_FOUND', `Comment not found: ${commentId}`);
  }
}

export class CommentAuthorForbiddenError extends BusinessRuleViolationError {
  constructor() {
    super('COMMENT_AUTHOR_FORBIDDEN', 'COMMENT_AUTHOR_FORBIDDEN');
  }
}
