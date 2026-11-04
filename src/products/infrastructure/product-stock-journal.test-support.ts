import type { ProductStockJournal } from './product-stock-journal';

/** Journal double for mock-based service specs; real behavior is covered by the integration spec. */
export function makeStockJournalStub() {
  // SAFETY: only the journal methods ProductsService calls are implemented.
  return {
    recordInitial: jest.fn().mockResolvedValue(undefined),
    removeProductStock: jest.fn().mockResolvedValue(undefined),
    removeVariantStock: jest.fn().mockResolvedValue(undefined),
    expiredLotQuantity: jest.fn().mockResolvedValue(0),
  } as unknown as jest.Mocked<ProductStockJournal>;
}
