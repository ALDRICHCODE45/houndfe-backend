import { canonicalEditorialJson } from './editorial-canonical-json';
import {
  parseBindingPolicyShapeV2,
  type BindingPolicy,
} from './editorial-vocabulary-policy-shape-v2';

export type BindingV2 = {
  definitionId: string;
  definitionCode: string;
  owner: 'product' | 'sellable';
  sortOrder: number;
  exposure: 'INTERNAL' | 'DETAIL' | 'FACET';
  searchable: boolean;
  publicationCheck: 'always' | 'when_asserted';
  policy: BindingPolicy;
};
export type FamilyV2 = {
  id: string;
  code: string;
  label: string;
  minimumContractVersion: 1 | 2;
  bindings: BindingV2[];
};

function invalid(): never {
  throw new TypeError('Expected a family shape V2');
}
function closed(value: unknown, keys: string[]): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid();
  const record = value as Record<string, unknown>;
  const actual = Object.keys(record);
  if (
    actual.length !== keys.length ||
    keys.some((key) => !actual.includes(key))
  )
    invalid();
  return record;
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.trim().length === 0) invalid();
  return value;
}
function unique(value: string, seen: Set<string>): string {
  if (seen.has(value)) invalid();
  seen.add(value);
  return value;
}
function parseBinding(
  input: unknown,
  ids: Set<string>,
  codes: Set<string>,
): BindingV2 {
  const b = closed(input, [
    'definitionId',
    'definitionCode',
    'owner',
    'sortOrder',
    'exposure',
    'searchable',
    'publicationCheck',
    'policy',
  ]);
  if (b.owner !== 'product' && b.owner !== 'sellable') invalid();
  if (
    b.exposure !== 'INTERNAL' &&
    b.exposure !== 'DETAIL' &&
    b.exposure !== 'FACET'
  )
    invalid();
  if (typeof b.searchable !== 'boolean') invalid();
  if (b.publicationCheck !== 'always' && b.publicationCheck !== 'when_asserted')
    invalid();
  if (typeof b.sortOrder !== 'number' || !Number.isSafeInteger(b.sortOrder))
    invalid();
  return {
    definitionId: unique(text(b.definitionId), ids),
    definitionCode: unique(text(b.definitionCode), codes),
    owner: b.owner,
    sortOrder: b.sortOrder,
    exposure: b.exposure,
    searchable: b.searchable,
    publicationCheck: b.publicationCheck,
    policy: parseBindingPolicyShapeV2(b.policy),
  };
}

/** Dormant closed shape only, NOT vocabulary or publication admission. */
export function parseFamilyShapeV2(input: unknown): FamilyV2 {
  // Guard the entire submitted tree before reading any submitted property.
  try {
    canonicalEditorialJson(input);
  } catch {
    invalid();
  }
  const f = closed(input, [
    'id',
    'code',
    'label',
    'minimumContractVersion',
    'bindings',
  ]);
  if (f.minimumContractVersion !== 1 && f.minimumContractVersion !== 2)
    invalid();
  if (!Array.isArray(f.bindings)) invalid();
  const ids = new Set<string>();
  const codes = new Set<string>();
  return {
    id: text(f.id),
    code: text(f.code),
    label: text(f.label),
    minimumContractVersion: f.minimumContractVersion,
    bindings: f.bindings.map((value: unknown) =>
      parseBinding(value, ids, codes),
    ),
  };
}
