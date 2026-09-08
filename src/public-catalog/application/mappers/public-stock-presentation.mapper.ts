import type { PublicStockPresentationDto } from '../dto/public-stock-presentation.dto';
import {
  renderAggregateVariantStockPresentation,
  renderStockPresentation,
  resolveProductStockPresentation,
  resolveVariantStockPresentation,
  type NonEmptyVariantOperationalStocks,
  type RenderedStockPresentation,
  type StockPresentationDefaults,
  type StockPresentationOperationalInput,
  type StockPresentationSource,
  type VariantOperationalStock,
} from '../../domain/value-objects/stock-presentation.vo';

/**
 * F2.WU6 slice 6 — dormant orchestration mapper for the public stock
 * presentation (design §9.2). Pure composition of the domain VO functions;
 * no rule is duplicated. Only the aggregate entry point can return
 * `invalid-participants`; the prohibited product-quantity aggregate fallback
 * is structurally impossible because the aggregate product input never
 * carries operational quantities.
 */
export type StockPresentationMappingResult =
  | { kind: 'mapped'; value: PublicStockPresentationDto }
  | { kind: 'invalid-participants' };

export interface PublicProductStockMappingInput {
  /** Product presentation source fields plus its operational stock. */
  product: StockPresentationSource & StockPresentationOperationalInput;
  tenant: StockPresentationDefaults;
}

export interface PublicVariantStockMappingInput {
  /** Product supplying `useStock` and the inherited presentation config. */
  product: StockPresentationSource & { useStock: boolean };
  /** Variant presentation source fields plus its operational stock. */
  variant: StockPresentationSource & Omit<StockPresentationOperationalInput, 'useStock'>;
  tenant: StockPresentationDefaults;
}

export interface PublicAggregateVariantStockMappingInput {
  /** Product supplying `useStock`; its quantities are never consulted. */
  product: StockPresentationSource & { useStock: boolean };
  tenant: StockPresentationDefaults;
  /** Runtime-validated participant array; extra keys are ignored. */
  variantParticipants: readonly unknown[];
}

function toDto(rendered: RenderedStockPresentation): PublicStockPresentationDto {
  return {
    mode: rendered.mode,
    status: rendered.status,
    customQuantity: rendered.customQuantity,
  };
}

/** Simple product: tenant→product resolution plus individual rendering. */
export function mapPublicProductStockPresentation(
  input: PublicProductStockMappingInput,
): StockPresentationMappingResult {
  const config = resolveProductStockPresentation(input.product, input.tenant);
  return { kind: 'mapped', value: toDto(renderStockPresentation(config, input.product)) };
}

/** Individual variant: tenant→product→variant resolution plus rendering. */
export function mapPublicVariantStockPresentation(
  input: PublicVariantStockMappingInput,
): StockPresentationMappingResult {
  const config = resolveVariantStockPresentation(
    input.variant,
    resolveProductStockPresentation(input.product, input.tenant),
  );
  return {
    kind: 'mapped',
    value: toDto(
      renderStockPresentation(config, {
        useStock: input.product.useStock,
        quantity: input.variant.quantity,
        minQuantity: input.variant.minQuantity,
      }),
    ),
  };
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isVariantOperationalStock(
  candidate: unknown,
): candidate is VariantOperationalStock {
  if (typeof candidate !== 'object' || candidate === null) return false;
  const record = candidate as Record<string, unknown>;
  return isFiniteNumber(record['quantity']) && isFiniteNumber(record['minQuantity']);
}

/** Aggregate variant product: product resolution plus participant aggregation. */
export function mapPublicAggregateVariantStockPresentation(
  input: PublicAggregateVariantStockMappingInput,
): StockPresentationMappingResult {
  const participants = input.variantParticipants;
  if (!Array.isArray(participants) || participants.length === 0) {
    return { kind: 'invalid-participants' };
  }
  if (!participants.every(isVariantOperationalStock)) {
    return { kind: 'invalid-participants' };
  }
  const config = resolveProductStockPresentation(input.product, input.tenant);
  return {
    kind: 'mapped',
    value: toDto(
      renderAggregateVariantStockPresentation(
        config,
        input.product.useStock,
        participants as NonEmptyVariantOperationalStocks,
      ),
    ),
  };
}
