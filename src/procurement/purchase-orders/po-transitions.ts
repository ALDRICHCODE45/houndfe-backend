import {
  Prisma,
  type ProcurementPurchaseOrder,
  type ProcurementPurchaseOrderLine,
} from '@prisma/client';
import {
  PurchaseOrderContractError,
  type PurchaseOrder,
  type PurchaseOrderCancel,
  type PurchaseOrderConfirm,
} from './po-contract';
import { readPurchaseOrderReferences } from './po-references';
import { computePurchaseOrderReferenceToken } from './po-reference-token';
import { buildPurchaseOrder, storedOrderInput } from './po-response';
import { buildPurchaseOrderDiagnostics } from './po-validation';

export interface TransitionScope {
  tenantId: string;
  tenantName: string;
  actorName: string;
}

/**
 * Caller holds the order row FOR UPDATE and has already passed the version CAS
 * and the DRAFT state check (S4 steps 1-2). Locks continue in the O3b order:
 * supplier FOR UPDATE -> products ascending FOR UPDATE -> variants FOR SHARE.
 * Checks run in the exact S4 order; the first failure wins.
 */
export async function confirmPurchaseOrder(
  tx: Prisma.TransactionClient,
  scope: TransitionScope,
  row: ProcurementPurchaseOrder,
  lines: ProcurementPurchaseOrderLine[],
  input: PurchaseOrderConfirm,
): Promise<PurchaseOrder> {
  if (row.supplierId === null)
    throw new PurchaseOrderContractError('ORDER_NOT_READY');
  const order = storedOrderInput(row, lines);
  const refs = await readPurchaseOrderReferences(
    tx,
    scope.tenantId,
    scope.tenantName,
    order,
  );
  // A vanished supplier cannot happen under the FK; fail closed regardless.
  if (refs.supplierVersion === null || refs.supplierDisplaySnapshot === null)
    throw new PurchaseOrderContractError('ORDER_NOT_READY');
  if (input.expectedSupplierVersion !== refs.supplierVersion)
    throw new PurchaseOrderContractError('SUPPLIER_VERSION_CONFLICT');
  if (refs.facts.supplier === 'ARCHIVED')
    throw new PurchaseOrderContractError('SUPPLIER_ARCHIVED');
  const token = computePurchaseOrderReferenceToken(order, refs.facts);
  if (token === null) throw new PurchaseOrderContractError('ORDER_NOT_READY');
  // Strict inequality: a null expected token never matches a non-null token.
  if (input.expectedReferenceToken !== token)
    throw new PurchaseOrderContractError('ELIGIBILITY_CHANGED');
  const diagnostics = buildPurchaseOrderDiagnostics(order, refs.facts);
  if (diagnostics.issues.length)
    throw new PurchaseOrderContractError('ORDER_NOT_READY');

  const changed = await tx.procurementPurchaseOrder.updateMany({
    where: {
      tenantId: scope.tenantId,
      id: row.id,
      version: input.expectedVersion,
    },
    data: {
      status: 'CONFIRMED',
      confirmedAt: new Date(),
      confirmedByDisplayName: scope.actorName,
      supplierDisplaySnapshot: { ...refs.supplierDisplaySnapshot },
      locationTenantName: refs.tenantName,
      // SAFETY: LineSubtotal[] is plain JSON (decimal strings, enums, null).
      lineSubtotalsSnapshot:
        diagnostics.lineSubtotals as unknown as Prisma.InputJsonArray,
      version: { increment: 1 },
    },
  });
  if (changed.count !== 1)
    throw new PurchaseOrderContractError('ORDER_VERSION_CONFLICT');
  const frozen = await tx.procurementPurchaseOrder.findFirstOrThrow({
    where: { tenantId: scope.tenantId, id: row.id },
  });
  const frozenLines = lines.map((line, index) => ({
    ...line,
    productName: refs.lineDisplaySnapshots[index].productName,
    variantName: refs.lineDisplaySnapshots[index].variantName,
    unitSnapshot: refs.lineDisplaySnapshots[index].unit,
  }));
  await tx.procurementPurchaseOrderLine.deleteMany({
    where: { tenantId: scope.tenantId, orderId: row.id },
  });
  await tx.procurementPurchaseOrderLine.createMany({ data: frozenLines });
  return buildPurchaseOrder(frozen, refs.supplierVersion, {
    lines: frozenLines,
  });
}

/**
 * Order lock only: no reference validation, no supplier/product locks and no
 * catalog permissions. The response's supplierCurrentVersion is the one live
 * value, read without a lock exactly like GET.
 */
export async function cancelPurchaseOrder(
  tx: Prisma.TransactionClient,
  scope: TransitionScope,
  row: ProcurementPurchaseOrder,
  lines: ProcurementPurchaseOrderLine[],
  input: PurchaseOrderCancel,
): Promise<PurchaseOrder> {
  const changed = await tx.procurementPurchaseOrder.updateMany({
    where: {
      tenantId: scope.tenantId,
      id: row.id,
      version: input.expectedVersion,
    },
    data: {
      status: 'CANCELLED',
      cancelledAt: new Date(),
      cancelledByDisplayName: scope.actorName,
      version: { increment: 1 },
    },
  });
  if (changed.count !== 1)
    throw new PurchaseOrderContractError('ORDER_VERSION_CONFLICT');
  const cancelled = await tx.procurementPurchaseOrder.findFirstOrThrow({
    where: { tenantId: scope.tenantId, id: row.id },
  });
  const suppliers =
    row.supplierId === null
      ? []
      : await tx.$queryRaw<{ version: number }[]>(Prisma.sql`
    SELECT s."version" FROM "procurement_suppliers" s
    WHERE s."tenantId" = ${scope.tenantId} AND s."id" = ${row.supplierId}
  `);
  return buildPurchaseOrder(cancelled, suppliers[0]?.version ?? null, {
    lines,
  });
}
