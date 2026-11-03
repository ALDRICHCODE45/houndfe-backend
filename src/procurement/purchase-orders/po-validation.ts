import type {
  LineSubtotal,
  OrderInput,
  PurchaseOrderIssue,
  PurchaseOrderIssueCode,
  UnitOfMeasure,
} from './po-contract';
import { isQuantityAllowedForUnit, multiplyDecimals } from './po-decimal';

export interface PurchaseOrderLineReferenceFacts {
  product:
    | 'missing'
    | {
        type: 'PRODUCT' | 'SERVICE';
        unit: UnitOfMeasure;
        hasVariants: boolean;
      };
  variant: 'missing' | { belongsToProduct: boolean };
}
/**
 * T3 resolves these facts inside the current tenant. Missing includes foreign ids.
 * Keys are normalized lineIds, not productIds: each line has its own variant fact.
 * Omitted line facts fail closed as missing. Facts for unselected ids are ignored.
 * This describes current compatibility only, not new-vs-retained reference policy;
 * commands enforce S9/S10 against the last successful persisted baseline.
 */
export interface PurchaseOrderReferenceFacts {
  supplier: 'missing' | 'ACTIVE' | 'ARCHIVED';
  lines: Readonly<Record<string, PurchaseOrderLineReferenceFacts | undefined>>;
}
export interface PurchaseOrderDiagnostics {
  issues: PurchaseOrderIssue[];
  lineSubtotals: LineSubtotal[];
}

/** Diagnostic only: no I/O, no mutation, no admission/authority decisions. */
export function buildPurchaseOrderDiagnostics(
  order: OrderInput,
  facts: PurchaseOrderReferenceFacts,
): PurchaseOrderDiagnostics {
  const issues: PurchaseOrderIssue[] = [];
  const issue = (path: string, code: PurchaseOrderIssueCode) => {
    issues.push({ path, code });
  };
  if (order.supplierId === null) issue('/supplierId', 'SUPPLIER_REQUIRED');
  else if (facts.supplier === 'missing')
    issue('/supplierId', 'REFERENCE_UNAVAILABLE');
  else if (facts.supplier === 'ARCHIVED')
    issue('/supplierId', 'SUPPLIER_ARCHIVED');
  if (!order.lines.length) issue('/lines', 'LINES_REQUIRED');

  const lineSubtotals = order.lines.map((line, index): LineSubtotal => {
    const path = `/lines/${index}`;
    const resolved = facts.lines[line.lineId];
    const product = resolved?.product ?? 'missing';
    const variant = resolved?.variant ?? 'missing';
    let compatible = true;
    if (line.productId === null) {
      issue(`${path}/productId`, 'PRODUCT_REQUIRED');
      compatible = false;
    } else if (product === 'missing') {
      issue(`${path}/productId`, 'REFERENCE_UNAVAILABLE');
      compatible = false;
    } else {
      if (product.type !== 'PRODUCT') {
        issue(`${path}/productId`, 'REFERENCE_INCOMPATIBLE');
        compatible = false;
      }
      if (product.hasVariants && line.variantId === null) {
        issue(`${path}/variantId`, 'VARIANT_REQUIRED');
        compatible = false;
      }
    }
    if (line.variantId !== null) {
      if (variant === 'missing') {
        issue(`${path}/variantId`, 'REFERENCE_UNAVAILABLE');
        compatible = false;
      } else if (
        !variant.belongsToProduct ||
        (product !== 'missing' && !product.hasVariants)
      ) {
        issue(`${path}/variantId`, 'REFERENCE_INCOMPATIBLE');
        compatible = false;
      }
    }
    if (line.orderedQuantity === null)
      issue(`${path}/orderedQuantity`, 'QUANTITY_REQUIRED');
    const cost = line.informedUnitCost;
    if (cost?.amount == null)
      issue(`${path}/informedUnitCost/amount`, 'COST_AMOUNT_REQUIRED');
    if (cost?.currency == null)
      issue(`${path}/informedUnitCost/currency`, 'COST_CURRENCY_REQUIRED');
    if (cost?.unit == null)
      issue(`${path}/informedUnitCost/unit`, 'COST_UNIT_REQUIRED');
    if (cost?.taxBasis == null)
      issue(`${path}/informedUnitCost/taxBasis`, 'COST_TAX_BASIS_REQUIRED');

    // Only a selected resolved PRODUCT supplies a meaningful unit constraint.
    if (
      line.productId !== null &&
      product !== 'missing' &&
      product.type === 'PRODUCT'
    ) {
      if (cost?.unit != null && cost.unit !== product.unit) {
        issue(`${path}/informedUnitCost/unit`, 'UNIT_MISMATCH');
        compatible = false;
      }
      if (
        line.orderedQuantity !== null &&
        !isQuantityAllowedForUnit(line.orderedQuantity, product.unit)
      ) {
        issue(`${path}/orderedQuantity`, 'QUANTITY_FRACTION_NOT_ALLOWED');
        compatible = false;
      }
    }
    return {
      lineId: line.lineId,
      subtotal:
        compatible &&
        line.orderedQuantity !== null &&
        cost?.amount != null &&
        cost.currency !== null &&
        cost.unit !== null &&
        cost.taxBasis !== null
          ? {
              amount: multiplyDecimals(line.orderedQuantity, cost.amount),
              currency: cost.currency,
              taxBasis: cost.taxBasis,
            }
          : null,
    };
  });
  // Ordinal comparison is stable across locales; array indexes are RFC 6901 tokens.
  issues.sort((a, b) => {
    if (a.path !== b.path) return a.path < b.path ? -1 : 1;
    return a.code === b.code ? 0 : a.code < b.code ? -1 : 1;
  });
  return { issues, lineSubtotals };
}
