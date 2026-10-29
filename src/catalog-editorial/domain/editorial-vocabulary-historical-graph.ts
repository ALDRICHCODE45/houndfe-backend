import { canonicalEditorialJson } from './editorial-canonical-json';

type Identity = { id: string; code: string; label: string };
type DefinitionTag =
  | 'text'
  | 'boolean'
  | 'number'
  | 'single'
  | 'multi'
  | 'range';
type HistoricalBinding = {
  familyId: string;
  definitionId: string;
  definitionCode: string;
  owner: 'product' | 'sellable';
  sortOrder: number;
  policy?: unknown;
};
/** Graph integrity only: raw leaves and policies are deliberately untrusted. */
export type HistoricalVocabularyGraph = {
  families: (Identity & {
    minimumContractVersion: 1 | 2;
    bindings: HistoricalBinding[];
  })[];
  definitions: (Identity & {
    type: DefinitionTag;
    units: unknown[];
    options: unknown[];
    numericPolicy?: unknown;
  })[];
};

function invalid(): never {
  throw new TypeError('Invalid historical vocabulary graph');
}

function record(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    invalid();
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== null && prototype !== Object.prototype) invalid();
  return value as Record<string, unknown>;
}

// Inspect only selected own properties; ignored future columns are not admission gates.
function field(value: unknown, key: string): HistoricalBinding['policy'] {
  const descriptor = Object.getOwnPropertyDescriptor(value, key);
  if (!descriptor) return undefined;
  if (!descriptor.enumerable || !('value' in descriptor)) invalid();
  return descriptor.value as unknown;
}

function array(value: unknown): unknown[] {
  if (!Array.isArray(value) || Object.getPrototypeOf(value) !== Array.prototype)
    invalid();
  if (Reflect.ownKeys(value).length !== value.length + 1) invalid();
  return Array.from({ length: value.length }, (_, i) => {
    const item = field(value, String(i));
    if (item === undefined) invalid();
    return item;
  });
}

function text(value: unknown): string {
  if (typeof value !== 'string') invalid();
  canonicalEditorialJson(value);
  return value;
}

function identity(value: Record<string, unknown>): Identity {
  return {
    id: text(field(value, 'id')),
    code: text(field(value, 'code')),
    label: text(field(value, 'label')),
  };
}

function unique(values: { id: string; code: string }[]): void {
  const ids = new Set<string>();
  const codes = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id) || codes.has(value.code)) invalid();
    ids.add(value.id);
    codes.add(value.code);
  }
}

// Called only after canonicalEditorialJson has rejected accessors/cycles/non-JSON.
function clone(value: unknown): HistoricalBinding['policy'] {
  if (Array.isArray(value)) return value.map(clone);
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(
      Object.keys(value).map((key) => [key, clone(field(value, key))]),
    );
  }
  return value;
}

function optionalRaw(
  value: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  if (!Object.hasOwn(value, key)) return {};
  const raw = field(value, key);
  canonicalEditorialJson(raw);
  return { [key]: clone(raw) };
}

function leaves(value: unknown, keys: string[]): unknown[] {
  return array(value).map((leaf) => {
    // Malformed JSON leaf values remain untrusted, not legacy-compatible by implication.
    if (leaf === null || typeof leaf !== 'object' || Array.isArray(leaf)) {
      canonicalEditorialJson(leaf);
      return clone(leaf);
    }
    const row = record(leaf);
    return Object.assign(
      {},
      ...keys.map((key) => optionalRaw(row, key)),
    ) as unknown;
  });
}

/** Dormant structural decoder; caller still owes provenance and compatibility. */
export function decodeHistoricalVocabularyGraph(
  input: unknown,
): HistoricalVocabularyGraph {
  const root = record(input);
  const definitions = array(field(root, 'definitions')).map<
    HistoricalVocabularyGraph['definitions'][number]
  >((entry) => {
    const row = record(entry);
    const type = field(row, 'type');
    if (
      type !== 'text' &&
      type !== 'boolean' &&
      type !== 'number' &&
      type !== 'single' &&
      type !== 'multi' &&
      type !== 'range'
    )
      invalid();
    return {
      ...identity(row),
      type,
      units: leaves(field(row, 'units'), [
        'id',
        'definitionId',
        'definitionType',
        'unitCode',
        'label',
        'sortOrder',
      ]),
      options: leaves(field(row, 'options'), [
        'definitionId',
        'definitionType',
        'code',
        'label',
        'archivedAt',
        'sortOrder',
      ]),
      ...optionalRaw(row, 'numericPolicy'),
    };
  });
  unique(definitions);
  const byId = new Map(definitions.map((d) => [d.id, d]));
  const families = array(field(root, 'families')).map<
    HistoricalVocabularyGraph['families'][number]
  >((entry) => {
    const row = record(entry);
    const ownIdentity = identity(row);
    const minimumContractVersion = field(row, 'minimumContractVersion');
    if (minimumContractVersion !== 1 && minimumContractVersion !== 2) invalid();
    const bindings = array(field(row, 'bindings')).map<HistoricalBinding>(
      (entry) => {
        const binding = record(entry);
        const familyId = text(field(binding, 'familyId'));
        const definitionId = text(field(binding, 'definitionId'));
        const definitionCode = text(field(binding, 'definitionCode'));
        const owner = field(binding, 'owner');
        const sortOrder = field(binding, 'sortOrder');
        if (owner !== 'product' && owner !== 'sellable') invalid();
        if (typeof sortOrder !== 'number' || !Number.isInteger(sortOrder))
          invalid();
        if (
          familyId !== ownIdentity.id ||
          byId.get(definitionId)?.code !== definitionCode
        )
          invalid();
        return {
          familyId,
          definitionId,
          definitionCode,
          owner,
          sortOrder,
          ...optionalRaw(binding, 'policy'),
        };
      },
    );
    unique(
      bindings.map((b) => ({ id: b.definitionId, code: b.definitionCode })),
    );
    return { ...ownIdentity, minimumContractVersion, bindings };
  });
  unique(families);
  return { families, definitions };
}
