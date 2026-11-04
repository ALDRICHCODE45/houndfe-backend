import {
  PurchaseOrderContractError,
  QUANTITY_PATTERN,
  UnitOfMeasure,
} from './po-contract';

export const DECIMAL_UNITS: ReadonlySet<UnitOfMeasure> = new Set([
  'KILOGRAMO',
  'GRAMO',
  'LITRO',
  'METRO',
  'CENTIMETRO',
]);

/** Fractional notation is reserved for decimal units, even if its digits are zero. */
export function isQuantityAllowedForUnit(
  quantity: string,
  unit: UnitOfMeasure,
): boolean {
  return (
    QUANTITY_PATTERN.test(quantity) &&
    /[1-9]/.test(quantity) &&
    (!quantity.includes('.') || DECIMAL_UNITS.has(unit))
  );
}

function scaled(value: string): { coefficient: bigint; scale: number } {
  if (!/^(0|[1-9][0-9]*)(\.[0-9]+)?$/.test(value))
    throw new PurchaseOrderContractError('MALFORMED');
  const [integer, fraction = ''] = value.split('.');
  return { coefficient: BigInt(integer + fraction), scale: fraction.length };
}

/** Canonical rendering: no leading/trailing zeros, "0" for zero. */
function render(coefficient: bigint, scale: number): string {
  if (coefficient === BigInt(0)) return '0';
  const digits = coefficient.toString().padStart(scale + 1, '0');
  if (!scale) return digits;
  return `${digits.slice(0, -scale)}.${digits.slice(-scale)}`
    .replace(/0+$/, '')
    .replace(/\.$/, '');
}

/** Exact unsigned decimal multiplication. Callers normally supply parsed wire values. */
export function multiplyDecimals(left: string, right: string): string {
  const a = scaled(left);
  const b = scaled(right);
  return render(a.coefficient * b.coefficient, a.scale + b.scale);
}

/** Exact unsigned decimal addition; the result is canonical like multiplyDecimals. */
export function addDecimals(left: string, right: string): string {
  const a = scaled(left);
  const b = scaled(right);
  const scale = Math.max(a.scale, b.scale);
  const lift = (value: typeof a) =>
    value.coefficient * BigInt(10) ** BigInt(scale - value.scale);
  return render(lift(a) + lift(b), scale);
}
