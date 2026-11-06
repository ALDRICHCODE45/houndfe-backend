/**
 * shipping-zones / T2 (S5) — "Un paquete por pedido".
 *
 * Pure packing rule consumed by the quote engine (T3): every order travels in
 * ONE standard box. Total weight = Σ package weight × quantity + box weight.
 * The box is the smallest active one (inner volume, tie → lighter own weight,
 * then id) such that:
 *   - every item fits on its own, comparing sorted dimensions (rotation free);
 *   - the summed item volume does not exceed the inner volume;
 *   - the max content weight holds the summed item weight.
 * No carrier, database or clock access happens here.
 */
import {
  BusinessRuleViolationError,
  InvalidArgumentError,
} from '../../../shared/domain/domain-error';

export interface PackageDims {
  lengthCm: number;
  widthCm: number;
  heightCm: number;
}

export interface PackageItem {
  productId: string;
  variantId: string | null;
  quantity: number;
  /** Packed-item weight in grams; null when the product has no packaging. */
  packageWeightG: number | null;
  /** Packed-item dimensions; null when the product has no packaging. */
  dims: PackageDims | null;
}

export interface StandardBox {
  id: string;
  name: string;
  innerLengthCm: number;
  innerWidthCm: number;
  innerHeightCm: number;
  weightG: number;
  maxContentWeightG: number;
}

export interface OrderPackage {
  box: StandardBox;
  contentWeightG: number;
  totalWeightG: number;
  /** Outer dimensions sent to carriers: the chosen box's inner dimensions. */
  dims: PackageDims;
}

export interface MissingPackagingRef {
  productId: string;
  variantId: string | null;
}

export class PackagingDataMissingError extends BusinessRuleViolationError {
  constructor(missing: MissingPackagingRef[]) {
    super(
      `Packaging data is missing for ${missing.length} item(s); set package weight and dimensions before quoting by carrier`,
      'PACKAGING_DATA_MISSING',
      { missing },
    );
  }
}

export class NoShippingBoxFitsError extends BusinessRuleViolationError {
  constructor(contentWeightG: number, boxesConsidered: number) {
    super(
      boxesConsidered === 0
        ? 'No active standard box is configured for this branch'
        : 'No active standard box fits the order items; add a larger or stronger box',
      'NO_SHIPPING_BOX_FITS',
      { contentWeightG, boxesConsidered },
    );
  }
}

const sortedDesc = (d: PackageDims): number[] =>
  [d.lengthCm, d.widthCm, d.heightCm].sort((a, b) => b - a);

const volume = (d: PackageDims): number => d.lengthCm * d.widthCm * d.heightCm;

const innerDims = (b: StandardBox): PackageDims => ({
  lengthCm: b.innerLengthCm,
  widthCm: b.innerWidthCm,
  heightCm: b.innerHeightCm,
});

const fitsInside = (item: number[], inner: number[]): boolean =>
  item.every((side, index) => side <= inner[index]);

type CompleteItem = PackageItem & { packageWeightG: number; dims: PackageDims };

function requireComplete(items: PackageItem[]): CompleteItem[] {
  const missing = new Map<string, MissingPackagingRef>();
  for (const line of items) {
    if (line.packageWeightG === null || line.dims === null) {
      const key = `${line.productId}:${line.variantId ?? ''}`;
      missing.set(key, {
        productId: line.productId,
        variantId: line.variantId,
      });
    }
  }
  if (missing.size > 0) {
    throw new PackagingDataMissingError([...missing.values()]);
  }
  return items as CompleteItem[];
}

export function buildOrderPackage(
  items: PackageItem[],
  activeBoxes: StandardBox[],
): OrderPackage {
  if (items.length === 0) {
    throw new InvalidArgumentError('An order package needs at least one item');
  }
  for (const line of items) {
    if (!Number.isInteger(line.quantity) || line.quantity <= 0) {
      throw new InvalidArgumentError(
        `Item quantity must be a positive integer (product ${line.productId})`,
      );
    }
  }

  const complete = requireComplete(items);
  const contentWeightG = complete.reduce(
    (sum, line) => sum + line.packageWeightG * line.quantity,
    0,
  );
  const contentVolume = complete.reduce(
    (sum, line) => sum + volume(line.dims) * line.quantity,
    0,
  );
  const itemSides = complete.map((line) => sortedDesc(line.dims));

  const candidates = activeBoxes
    .filter((candidate) => {
      const inner = sortedDesc(innerDims(candidate));
      return (
        candidate.maxContentWeightG >= contentWeightG &&
        volume(innerDims(candidate)) >= contentVolume &&
        itemSides.every((sides) => fitsInside(sides, inner))
      );
    })
    .sort(
      (a, b) =>
        volume(innerDims(a)) - volume(innerDims(b)) ||
        a.weightG - b.weightG ||
        a.id.localeCompare(b.id),
    );

  const chosen = candidates[0];
  if (!chosen) {
    throw new NoShippingBoxFitsError(contentWeightG, activeBoxes.length);
  }

  return {
    box: chosen,
    contentWeightG,
    totalWeightG: contentWeightG + chosen.weightG,
    dims: innerDims(chosen),
  };
}
