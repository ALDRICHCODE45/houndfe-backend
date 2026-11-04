import type {
  ProcurementPurchaseOrder,
  ProcurementPurchaseOrderLine,
} from '@prisma/client';
import type {
  LineSubtotal,
  OrderInput,
  PurchaseOrder,
  PurchaseOrderIssue,
  PurchaseOrderStatus,
  SupplierDisplaySnapshot,
} from './po-contract';
import { computePurchaseOrderReferenceToken } from './po-reference-token';
import {
  buildPurchaseOrderDiagnostics,
  type PurchaseOrderReferenceFacts,
} from './po-validation';

const INVALID_REFERENCE_CODES = new Set([
  'REFERENCE_UNAVAILABLE',
  'REFERENCE_INCOMPATIBLE',
  'UNIT_MISMATCH',
  'QUANTITY_FRACTION_NOT_ALLOWED',
]);

/** Live reads for a DRAFT; the caller decides how labels fall back to saved ones. */
export interface DraftResponseSource {
  order: OrderInput;
  facts: PurchaseOrderReferenceFacts;
  tenantName: string;
  displays: (invalidLines: ReadonlySet<number>) => {
    supplierDisplaySnapshot: PurchaseOrder['supplierDisplaySnapshot'];
    lineDisplaySnapshots: PurchaseOrder['lineDisplaySnapshots'];
  };
}
/** Stored columns only, for CONFIRMED/CANCELLED. */
export interface FrozenResponseSource {
  lines: ProcurementPurchaseOrderLine[];
}

/** S3: every clause is explicit so an archived supplier can never enable confirm. */
export function canConfirmPurchaseOrder(input: {
  status: PurchaseOrderStatus;
  issueCount: number;
  referenceToken: string | null;
  supplierCurrentVersion: number | null;
  supplierStatus: PurchaseOrderReferenceFacts['supplier'] | null;
}): boolean {
  return (
    input.status === 'DRAFT' &&
    input.issueCount === 0 &&
    input.referenceToken !== null &&
    input.supplierCurrentVersion !== null &&
    input.supplierStatus === 'ACTIVE'
  );
}

export function storedOrderInput(
  row: Pick<ProcurementPurchaseOrder, 'supplierId' | 'note' | 'locationDetail'>,
  lines: ProcurementPurchaseOrderLine[],
): OrderInput {
  return {
    supplierId: row.supplierId,
    note: row.note,
    location: { detail: row.locationDetail },
    lines: lines.map((line) => ({
      lineId: line.lineId,
      productId: line.productId,
      variantId: line.variantId,
      orderedQuantity: line.orderedQuantity,
      informedUnitCost: line.informedUnitCostPresent
        ? {
            amount: line.costAmount,
            currency: line.currency as 'MXN' | null,
            unit: line.costUnit,
            taxBasis: line.taxBasis,
          }
        : null,
    })),
  };
}

function invalidLineIndexes(issues: PurchaseOrderIssue[]): Set<number> {
  const indexes = new Set<number>();
  for (const issue of issues) {
    const match = /^\/lines\/(\d+)\//.exec(issue.path);
    if (match && INVALID_REFERENCE_CODES.has(issue.code))
      indexes.add(Number(match[1]));
  }
  return indexes;
}

/**
 * The only PurchaseOrder wire builder: queries and commands share it so POST,
 * PUT and GET (and later confirm/cancel) return identical shapes.
 * DRAFT reads live references; CONFIRMED/CANCELLED read stored columns only and
 * never consult live product/variant/supplier/tenant names. `supplierCurrentVersion`
 * is the one live value on closed orders (informational; canConfirm is false).
 * A CANCELLED-from-DRAFT order has no frozen subtotals: one `subtotal: null` per
 * line, never an unvalidated live-free recomputation.
 */
export function buildPurchaseOrder(
  row: ProcurementPurchaseOrder,
  supplierCurrentVersion: number | null,
  source: DraftResponseSource | FrozenResponseSource,
): PurchaseOrder {
  const common = {
    id: row.id,
    version: row.version,
    status: row.status,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
    supplierCurrentVersion,
    confirmedAt: row.confirmedAt?.toISOString() ?? null,
    confirmedBy:
      row.confirmedByDisplayName === null
        ? null
        : { displayName: row.confirmedByDisplayName },
    cancelledAt: row.cancelledAt?.toISOString() ?? null,
    cancelledBy:
      row.cancelledByDisplayName === null
        ? null
        : { displayName: row.cancelledByDisplayName },
  };
  if (row.status === 'DRAFT') {
    if (!('order' in source)) throw new Error('DRAFT needs live references');
    const { order, facts } = source;
    const diagnostics = buildPurchaseOrderDiagnostics(order, facts);
    const referenceToken = computePurchaseOrderReferenceToken(order, facts);
    const displays = source.displays(invalidLineIndexes(diagnostics.issues));
    return {
      ...order,
      ...common,
      supplierDisplaySnapshot:
        order.supplierId === null ? null : displays.supplierDisplaySnapshot,
      lineDisplaySnapshots: displays.lineDisplaySnapshots,
      lineSubtotals: diagnostics.lineSubtotals,
      locationSnapshot: {
        tenantId: row.tenantId,
        tenantName: source.tenantName,
        detail: order.location.detail,
      },
      validation: { issues: diagnostics.issues },
      referenceToken,
      canConfirm: canConfirmPurchaseOrder({
        status: row.status,
        issueCount: diagnostics.issues.length,
        referenceToken,
        supplierCurrentVersion,
        supplierStatus: facts.supplier,
      }),
    };
  }
  if (!('lines' in source)) throw new Error('Closed order needs stored lines');
  const order = storedOrderInput(row, source.lines);
  // SAFETY: only this service writes these JSON columns, as wire objects.
  const frozenSupplier =
    row.supplierId === null
      ? null
      : (row.supplierDisplaySnapshot as unknown as SupplierDisplaySnapshot | null);
  // SAFETY: lineSubtotalsSnapshot is written by this service as LineSubtotal[].
  const stored = (row.lineSubtotalsSnapshot ?? []) as unknown as LineSubtotal[];
  const frozenSubtotals = new Map(stored.map((entry) => [entry.lineId, entry]));
  return {
    ...order,
    ...common,
    supplierDisplaySnapshot: frozenSupplier,
    lineDisplaySnapshots: source.lines.map((line) => ({
      lineId: line.lineId,
      productName: line.productName,
      variantName: line.variantName,
      unit: line.unitSnapshot,
    })),
    lineSubtotals: source.lines.map(
      (line): LineSubtotal =>
        frozenSubtotals.get(line.lineId) ?? {
          lineId: line.lineId,
          subtotal: null,
        },
    ),
    locationSnapshot: {
      tenantId: row.tenantId,
      tenantName: row.locationTenantName,
      detail: row.locationDetail,
    },
    validation: { issues: [] },
    referenceToken: null,
    canConfirm: false,
  };
}
