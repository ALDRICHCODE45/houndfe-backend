import type { PurchaseOrderIssue } from './po-contract';
import { summarizePurchaseOrderIssues } from './po-issue-summary';

const issue = (
  path: string,
  code: PurchaseOrderIssue['code'],
): PurchaseOrderIssue => ({ path, code });

describe('summarizePurchaseOrderIssues', () => {
  it('is empty for an order without issues', () => {
    expect(summarizePurchaseOrderIssues([])).toEqual({
      issueSummary: { cost: 0, quantity: 0, reference: 0, order: [] },
      checklistItemCount: 0,
    });
  });

  it('counts affected lines per line family, not sub-fields', () => {
    const result = summarizePurchaseOrderIssues([
      issue('/lines/0/cost/amount', 'COST_AMOUNT_REQUIRED'),
      issue('/lines/0/cost/currency', 'COST_CURRENCY_REQUIRED'),
      issue('/lines/2/cost/taxBasis', 'COST_TAX_BASIS_REQUIRED'),
      issue('/lines/1/quantity', 'QUANTITY_REQUIRED'),
      issue('/lines/1/productId', 'PRODUCT_REQUIRED'),
      issue('/lines/3/reference', 'REFERENCE_UNAVAILABLE'),
    ]);
    expect(result.issueSummary).toEqual({
      cost: 2,
      quantity: 1,
      reference: 2,
      order: [],
    });
    expect(result.checklistItemCount).toBe(3);
  });

  it('lists distinct order-level codes in first-seen order', () => {
    const result = summarizePurchaseOrderIssues([
      issue('/supplierId', 'SUPPLIER_ARCHIVED'),
      issue('/lines', 'LINES_REQUIRED'),
      issue('/lines/0/unit', 'UNIT_MISMATCH'),
      issue('/lines/1/unit', 'UNIT_MISMATCH'),
      issue('/lines/0/cost/unit', 'COST_UNIT_REQUIRED'),
    ]);
    expect(result.issueSummary).toEqual({
      cost: 1,
      quantity: 0,
      reference: 0,
      order: ['SUPPLIER_ARCHIVED', 'LINES_REQUIRED', 'UNIT_MISMATCH'],
    });
    expect(result.checklistItemCount).toBe(4);
  });
});
