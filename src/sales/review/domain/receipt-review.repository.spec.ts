import {
  RECEIPT_REVIEW_REPOSITORY,
  type ReceiptReviewRepository,
} from './receipt-review.repository';

describe('ReceiptReviewRepository port', () => {
  it('defines the review data access contract', () => {
    const repository: ReceiptReviewRepository = {
      findPendingForSale: jest.fn(),
      findById: jest.fn(),
      markConfirmed: jest.fn(),
      markRejected: jest.fn(),
    };

    expect(RECEIPT_REVIEW_REPOSITORY).toEqual(
      Symbol.for('ReceiptReviewRepository'),
    );
    expect(typeof repository.findPendingForSale).toBe('function');
    expect(typeof repository.findById).toBe('function');
    expect(typeof repository.markConfirmed).toBe('function');
    expect(typeof repository.markRejected).toBe('function');
  });
});
