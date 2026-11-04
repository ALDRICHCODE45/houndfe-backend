import type { PurchaseOrderIssue, PurchaseOrderIssueCode } from './po-contract';

/** Same grouping as the FE order checklist: one item per line family, one per order-level code. */
export interface PurchaseOrderIssueSummary {
  /** Lines with at least one cost issue. */
  cost: number;
  /** Lines with at least one quantity issue. */
  quantity: number;
  /** Lines with at least one product/variant reference issue. */
  reference: number;
  /** Distinct order-level codes, in first-seen order. */
  order: PurchaseOrderIssueCode[];
}

type LineFamily = 'cost' | 'quantity' | 'reference';

const LINE_FAMILIES: Partial<Record<PurchaseOrderIssueCode, LineFamily>> = {
  COST_AMOUNT_REQUIRED: 'cost',
  COST_CURRENCY_REQUIRED: 'cost',
  COST_UNIT_REQUIRED: 'cost',
  COST_TAX_BASIS_REQUIRED: 'cost',
  QUANTITY_REQUIRED: 'quantity',
  QUANTITY_FRACTION_NOT_ALLOWED: 'quantity',
  PRODUCT_REQUIRED: 'reference',
  VARIANT_REQUIRED: 'reference',
  REFERENCE_UNAVAILABLE: 'reference',
  REFERENCE_INCOMPATIBLE: 'reference',
};

const LINE_PATH = /^\/lines\/(\d+)(?:\/|$)/;

export function summarizePurchaseOrderIssues(issues: PurchaseOrderIssue[]): {
  issueSummary: PurchaseOrderIssueSummary;
  checklistItemCount: number;
} {
  const lines: Record<LineFamily, Set<string>> = {
    cost: new Set(),
    quantity: new Set(),
    reference: new Set(),
  };
  const order: PurchaseOrderIssueCode[] = [];
  for (const issue of issues) {
    const family = LINE_FAMILIES[issue.code];
    if (family) {
      lines[family].add(LINE_PATH.exec(issue.path)?.[1] ?? issue.path);
    } else if (!order.includes(issue.code)) {
      order.push(issue.code);
    }
  }
  const issueSummary = {
    cost: lines.cost.size,
    quantity: lines.quantity.size,
    reference: lines.reference.size,
    order,
  };
  const checklistItemCount =
    Number(issueSummary.cost > 0) +
    Number(issueSummary.quantity > 0) +
    Number(issueSummary.reference > 0) +
    order.length;
  return { issueSummary, checklistItemCount };
}
