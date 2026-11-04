import { DomainError } from '../../shared/domain/domain-error';

/** Maps to 409 INSUFFICIENT_STOCK: the change would leave a bucket (or the product) below 0. */
export class InsufficientStockError extends DomainError {
  constructor(
    public readonly bucketKind: string,
    public readonly bucketId: string,
    public readonly available: number,
    public readonly requested: number,
  ) {
    super(
      `Insufficient stock in ${bucketKind} ${bucketId}: available ${available}, requested ${requested}`,
      'INSUFFICIENT_STOCK',
    );
  }
}

/** Maps to 409 STOCK_VERSION_CONFLICT: the bucket changed since the caller read it. */
export class StockVersionConflictError extends DomainError {
  constructor(
    public readonly bucketKind: string,
    public readonly bucketId: string,
    public readonly currentVersion: number,
  ) {
    super(
      `Stock bucket ${bucketKind} ${bucketId} changed (current version ${currentVersion})`,
      'STOCK_VERSION_CONFLICT',
    );
  }
}

/** Maps to 404: product/variant/lot does not exist (or does not belong to the tenant). */
export class StockBucketNotFoundError extends DomainError {
  constructor(bucketKind: string, bucketId: string) {
    super(
      `Stock bucket ${bucketKind} ${bucketId} not found`,
      'STOCK_BUCKET_NOT_FOUND',
    );
  }
}

/** Maps to 422: untracked stock requested on a product with useStock=false. */
export class StockNotTrackedError extends DomainError {
  constructor(productId: string) {
    super(`Product ${productId} does not track stock`, 'STOCK_NOT_TRACKED');
  }
}
