import type { PublicStockStatus } from '../../domain/value-objects/stock-status.vo';

/**
 * F2.WU6 slice 6 — effective stock-presentation mode restated as a stable
 * application contract (OpenSpec design §9.2); not an alias of the domain
 * `RenderedStockPresentation` interface.
 */
export type PublicStockPresentationMode =
  | 'SYSTEM_STATUS'
  | 'ABSTRACT_STATUS'
  | 'CUSTOM_QUANTITY'
  | 'HIDDEN';

/**
 * F2.WU6 slice 6 — stable public stock projection (design §9.2). Carries
 * only presentation; operational `quantity`/`minQuantity` fields are
 * intentionally absent and must never leak into public responses.
 */
export interface PublicStockPresentationDto {
  /** Effective mode after tenant-default and product/variant resolution. */
  mode: PublicStockPresentationMode;
  /** Public stock status, or `null` when the mode hides the indicator. */
  status: PublicStockStatus | null;
  /** Configured presentation quantity for `CUSTOM_QUANTITY`, else `null`. */
  customQuantity: number | null;
}
