import { canonicalEditorialJson } from './editorial-canonical-json';

export type UnitV2 = {
  code: string | null;
  label: string | null;
  sortOrder: number;
};
export type NumericPolicyV2 =
  | { status: 'pending' }
  | {
      status: 'resolved';
      magnitude: string;
      integer: boolean;
      lower: number | null;
      lowerInclusive: boolean;
      upper: number | null;
      upperInclusive: boolean;
    };
export type NumericDefinitionV2 = {
  id: string;
  code: string;
  label: string;
  type: 'number' | 'range';
  units: UnitV2[];
  numericPolicy: NumericPolicyV2;
};

function invalid(): never {
  throw new TypeError('Expected a numeric definition V2');
}

function closed(value: unknown, keys?: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    invalid();
  }
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (
    keys &&
    (actual.length !== keys.length || keys.some((key) => !actual.includes(key)))
  ) {
    invalid();
  }
  return record;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) invalid();
  return value;
}

function policy(value: unknown): NumericPolicyV2 {
  const status = closed(value).status;
  if (status === 'pending') {
    closed(value, ['status']);
    return { status };
  }
  const p = closed(value, [
    'status',
    'magnitude',
    'integer',
    'lower',
    'lowerInclusive',
    'upper',
    'upperInclusive',
  ]);
  if (
    status !== 'resolved' ||
    typeof p.magnitude !== 'string' ||
    typeof p.integer !== 'boolean' ||
    typeof p.lowerInclusive !== 'boolean' ||
    typeof p.upperInclusive !== 'boolean'
  )
    invalid();
  const bound = (v: unknown): v is number | null =>
    v === null || (typeof v === 'number' && Number.isFinite(v));
  if (!bound(p.lower) || !bound(p.upper)) invalid();
  if (
    (p.lower === null && p.lowerInclusive) ||
    (p.upper === null && p.upperInclusive) ||
    (p.lower !== null &&
      p.upper !== null &&
      (p.lower > p.upper ||
        (p.lower === p.upper && (!p.lowerInclusive || !p.upperInclusive))))
  )
    invalid();
  return {
    status,
    magnitude: p.magnitude,
    integer: p.integer,
    lower: p.lower,
    lowerInclusive: p.lowerInclusive,
    upper: p.upper,
    upperInclusive: p.upperInclusive,
  };
}

/** Closed generic metadata parser; no production mapping or runtime activation. */
export function validateNumericDefinitionV2(
  input: unknown,
): NumericDefinitionV2 {
  // Guard descriptors and the entire tree before reading any submitted property.
  try {
    canonicalEditorialJson(input);
  } catch {
    invalid();
  }
  const d = closed(input, [
    'id',
    'code',
    'label',
    'type',
    'units',
    'numericPolicy',
  ]);
  if (d.type !== 'number' && d.type !== 'range') invalid();
  if (!Array.isArray(d.units)) invalid();
  const seen = new Set<string | null>();
  const units = d.units.map((value: unknown): UnitV2 => {
    const u = closed(value, ['code', 'label', 'sortOrder']);
    const code = u.code === null ? null : text(u.code);
    const label = u.label === null ? null : text(u.label);
    if (
      (code === null) !== (label === null) ||
      (d.type === 'range' && code === null) ||
      seen.has(code) ||
      typeof u.sortOrder !== 'number' ||
      !Number.isSafeInteger(u.sortOrder)
    )
      invalid();
    seen.add(code);
    return { code, label, sortOrder: u.sortOrder };
  });
  return {
    id: text(d.id),
    code: text(d.code),
    label: text(d.label),
    type: d.type,
    units,
    numericPolicy: policy(d.numericPolicy),
  };
}
