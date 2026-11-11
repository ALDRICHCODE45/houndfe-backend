/**
 * `decision` of the request detail (contract §12.6): the projection the old
 * screens already serve for the wrapped table, without new fields. Customer
 * phone and conversation reference of the wrapped rows are never read. Where
 * the staff-visible `resolution` goes is decided by the service (it comes from
 * the request row, the same for every subtype).
 */
import type { ZoneImpactView } from '../application/chatbot-request-commands.service';
import type { ChatbotRequestSubtype } from '../domain/chatbot-request.commands';
import { readZoneImpact, type TenantClient } from './chatbot-request-writes';

export interface WrappedLinks {
  humanDecisionId: string | null;
  deliveryZoneRequestId: string | null;
  receiptEvidenceId: string | null;
}

export interface DecisionRead {
  decision: Record<string, unknown> | null;
  zoneImpact: ZoneImpactView | null;
}

const NONE: DecisionRead = { decision: null, zoneImpact: null };
const iso = (value: Date | null) => (value ? value.toISOString() : null);

export async function readDecision(
  db: TenantClient,
  tenantId: string,
  subtype: ChatbotRequestSubtype,
  links: WrappedLinks,
): Promise<DecisionRead> {
  if (
    (subtype === 'RESTOCK' || subtype === 'EXPIRATION') &&
    links.humanDecisionId
  ) {
    const hd = await db.humanDecision.findFirst({
      where: { tenantId, id: links.humanDecisionId },
    });
    if (!hd) return NONE;
    const snapshot =
      subtype === 'RESTOCK'
        ? {
            branchName: hd.branchName,
            productId: hd.productId,
            productName: hd.productName,
            variantId: hd.variantId,
            sku: hd.sku,
            requestedQuantity: hd.requestedQuantity,
            observedStockAtRequest: hd.observedStockAtRequest,
            stockObservedAt: iso(hd.stockObservedAt),
          }
        : {
            branchId: hd.branchId,
            branchName: hd.branchName,
            productId: hd.productId,
            productName: hd.productName,
            unit: hd.productUnit,
            variantId: hd.variantId,
            variantName: hd.variantName,
            variantOption: hd.variantOption,
            variantValue: hd.variantValue,
          };
    return { decision: { subtype, snapshot }, zoneImpact: null };
  }
  if (subtype === 'DELIVERY_ZONE' && links.deliveryZoneRequestId) {
    const zone = await db.deliveryZoneRequest.findFirst({
      where: { tenantId, id: links.deliveryZoneRequestId },
      select: {
        validationId: true,
        zipCode: true,
        state: true,
        municipality: true,
        neighborhood: true,
        lastCustomerMessageAt: true,
      },
    });
    if (!zone) return NONE;
    const { validationId } = zone;
    const zoneImpact = validationId
      ? await readZoneImpact(db, tenantId, validationId)
      : null;
    // Same projection as the legacy zone screen: every requester of the
    // validation counts, whatever its state (`zoneImpact.requests` is only the
    // open ones, what resolving would settle).
    const requesterCount = validationId
      ? await db.deliveryZoneRequest.count({
          where: { tenantId, validationId },
        })
      : 1;
    return {
      decision: {
        subtype,
        validationId: zone.validationId,
        zipCode: zone.zipCode,
        state: zone.state,
        municipality: zone.municipality,
        neighborhood: zone.neighborhood,
        requesterCount,
        lastCustomerMessageAt: iso(zone.lastCustomerMessageAt),
      },
      zoneImpact,
    };
  }
  if (subtype === 'TRANSFER_RECEIPT' && links.receiptEvidenceId) {
    const receipt = await db.receiptEvidence.findFirst({
      where: { tenantId, id: links.receiptEvidenceId },
      include: {
        sale: {
          select: {
            folio: true,
            totalCents: true,
            paidCents: true,
            debtCents: true,
          },
        },
      },
    });
    if (!receipt) return NONE;
    const base = `/sales/${receipt.saleId}/receipts/${receipt.id}`;
    const purged = receipt.purgedAt !== null;
    return {
      decision: {
        subtype,
        receiptId: receipt.id,
        saleId: receipt.saleId,
        saleFolio: receipt.sale.folio,
        declaredAmountCents: receipt.declaredAmountCents ?? 0,
        declaredAmountProvided: receipt.declaredAmountCents !== null,
        declaredDate: iso(receipt.declaredDate),
        declaredReference: receipt.declaredReference,
        saleTotalCents: receipt.sale.totalCents,
        salePaidCents: receipt.sale.paidCents,
        saleDebtCents: receipt.sale.debtCents,
        file: receipt.mimeType
          ? {
              mimeType: receipt.mimeType,
              sizeBytes: receipt.sizeBytes,
              previewStatus:
                receipt.previewStatus === 'READY' ? 'READY' : 'UNAVAILABLE',
              originalUrl: purged ? null : `${base}/file`,
              previewUrl:
                purged || receipt.previewStatus !== 'READY'
                  ? null
                  : `${base}/preview`,
            }
          : null,
        extracted: receipt.extracted ?? null,
        mismatch: receipt.mismatch ?? null,
      },
      zoneImpact: null,
    };
  }
  return NONE;
}
