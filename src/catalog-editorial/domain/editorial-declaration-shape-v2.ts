import { EditorialDocumentShapeError } from './editorial-document-shape-error';
import { parseEvidenceShapeV2, type EvidenceV2 } from './editorial-evidence-v2';

type DeclarationValues = {
  contentMagnitude: 'mass' | 'volume' | 'count' | 'length' | 'area';
  consumable: boolean;
  animalApplied: boolean;
  fitDeterminesChoice: boolean;
  capacityDeterminesChoice: boolean;
  electricalApplies: boolean;
  relevantDimensionCodes: { codes: string[]; toyTypes: string[] };
  relevantFitCodes: string[];
  relevantCapacityCodes: string[];
  relevantEquipmentCodes: string[];
  presentationKind: 'formulation' | 'device' | 'packaging';
  optionalNonpertinenceCodes: string[];
};
export type DeclarationShapeV2 = {
  [K in keyof DeclarationValues]:
    | { key: K; state: 'unknown'; evidence: null }
    | {
        key: K;
        state: 'known';
        value: DeclarationValues[K];
        evidence: EvidenceV2;
        basis: string;
      };
}[keyof DeclarationValues];

function invalid(): never {
  throw new EditorialDocumentShapeError('Expected a declaration shape V2');
}

function record(input: unknown, keys: string[]): Record<string, unknown> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid();
  const prototype: unknown = Object.getPrototypeOf(input);
  if (prototype !== Object.prototype && prototype !== null) invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input);
  if (Reflect.ownKeys(descriptors).length !== keys.length) invalid();
  const data: Record<string, unknown> = {};
  for (const key of keys) {
    if (!Object.hasOwn(descriptors, key)) invalid();
    const descriptor = descriptors[key];
    if (!descriptor.enumerable || !('value' in descriptor)) invalid();
    data[key] = descriptor.value;
  }
  return data;
}

function strings(input: unknown): string[] {
  if (!Array.isArray(input) || Object.getPrototypeOf(input) !== Array.prototype)
    invalid();
  const descriptors = Object.getOwnPropertyDescriptors(input as object);
  const length = descriptors.length.value as number;
  if (Reflect.ownKeys(descriptors).length !== length + 1) invalid();
  const result: string[] = [];
  for (let index = 0; index < length; index++) {
    const descriptor = descriptors[index];
    if (
      !descriptor ||
      !descriptor.enumerable ||
      !('value' in descriptor) ||
      typeof descriptor.value !== 'string'
    )
      invalid();
    result.push(descriptor.value);
  }
  return result;
}

/** Primitive wire shape only; referenced codes remain unvalidated strings. */
export function parseDeclarationShapeV2(input: unknown): DeclarationShapeV2 {
  // Inspect descriptors before deciding the exact branch, never submitted getters.
  if (!input || typeof input !== 'object') invalid();
  const state = Object.getOwnPropertyDescriptor(input, 'state');
  if (!state || !state.enumerable || !('value' in state)) invalid();
  const data = record(
    input,
    state.value === 'unknown'
      ? ['key', 'state', 'evidence']
      : ['key', 'state', 'value', 'evidence', 'basis'],
  );
  const { key } = data;
  const booleanKeys = [
    'consumable',
    'animalApplied',
    'fitDeterminesChoice',
    'capacityDeterminesChoice',
    'electricalApplies',
  ];
  const subsetKeys = [
    'relevantFitCodes',
    'relevantCapacityCodes',
    'relevantEquipmentCodes',
    'optionalNonpertinenceCodes',
  ];
  if (
    typeof key !== 'string' ||
    ![
      ...booleanKeys,
      ...subsetKeys,
      'contentMagnitude',
      'presentationKind',
      'relevantDimensionCodes',
    ].includes(key)
  )
    invalid();
  if (data.state === 'unknown') {
    if (data.evidence !== null) invalid();
    return { key, state: 'unknown', evidence: null } as DeclarationShapeV2;
  }
  if (
    data.state !== 'known' ||
    typeof data.basis !== 'string' ||
    data.evidence == null
  )
    invalid();
  let value: unknown = data.value;
  if (booleanKeys.includes(key)) {
    if (typeof value !== 'boolean') invalid();
  } else if (subsetKeys.includes(key)) {
    value = strings(value);
  } else if (key === 'relevantDimensionCodes') {
    const dimension = record(value, ['codes', 'toyTypes']);
    value = {
      codes: strings(dimension.codes),
      toyTypes: strings(dimension.toyTypes),
    };
  } else {
    const tokens =
      key === 'contentMagnitude'
        ? ['mass', 'volume', 'count', 'length', 'area']
        : ['formulation', 'device', 'packaging'];
    if (typeof value !== 'string' || !tokens.includes(value)) invalid();
  }
  // The key-specific checks above establish the mapped wire union.
  return {
    key,
    state: 'known',
    value,
    evidence: parseEvidenceShapeV2(data.evidence),
    basis: data.basis,
  } as DeclarationShapeV2;
}
