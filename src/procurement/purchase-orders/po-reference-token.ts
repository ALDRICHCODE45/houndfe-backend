import { createHash } from 'node:crypto';
import type { OrderInput, PurchaseOrderIssueCode } from './po-contract';
import {
  buildPurchaseOrderDiagnostics,
  type PurchaseOrderReferenceFacts,
} from './po-validation';

const TOKEN_VERSION = 'prt1';
// A reference fact is incomplete or invalid when any of these is reported.
// Completeness issues (quantity, cost) and supplier archive status are not
// reference facts: confirm orders them separately (S4 steps 5 and 8).
const REFERENCE_BLOCKERS: ReadonlySet<PurchaseOrderIssueCode> = new Set([
  'SUPPLIER_REQUIRED',
  'LINES_REQUIRED',
  'PRODUCT_REQUIRED',
  'VARIANT_REQUIRED',
  'REFERENCE_UNAVAILABLE',
  'REFERENCE_INCOMPATIBLE',
  'UNIT_MISMATCH',
]);

/**
 * Opaque, deterministic fingerprint of the reference facts observed for a draft:
 * supplier id plus, per lineId (sorted, so the lines form a set), the selected
 * productId/variantId and the observed product type, unit, hasVariants and
 * variant-belongs-to-parent. Quantities, costs, prices, stock, labels, notes and
 * supplier archive status are deliberately excluded. Null when any reference is
 * incomplete or invalid, so null never authorizes confirmation. Pure: the same
 * facts must be passed under locks to recompute it at confirm.
 */
export function computePurchaseOrderReferenceToken(
  order: OrderInput,
  facts: PurchaseOrderReferenceFacts,
): string | null {
  const { issues } = buildPurchaseOrderDiagnostics(order, facts);
  if (issues.some((issue) => REFERENCE_BLOCKERS.has(issue.code))) return null;
  const lines = order.lines
    .map((line) => {
      const fact = facts.lines[line.lineId];
      const product = fact?.product;
      const variant = fact?.variant;
      if (!product || product === 'missing') return null;
      return [
        line.lineId,
        line.productId,
        line.variantId,
        product.type,
        product.unit,
        product.hasVariants,
        line.variantId === null || !variant || variant === 'missing'
          ? null
          : variant.belongsToProduct,
      ];
    })
    .sort((a, b) => {
      const left = String(a?.[0]);
      const right = String(b?.[0]);
      return left < right ? -1 : left > right ? 1 : 0;
    });
  if (lines.includes(null)) return null;
  const digest = createHash('sha256')
    .update(JSON.stringify([TOKEN_VERSION, order.supplierId, lines]), 'utf8')
    .digest('base64url');
  return `${TOKEN_VERSION}.${digest}`;
}
