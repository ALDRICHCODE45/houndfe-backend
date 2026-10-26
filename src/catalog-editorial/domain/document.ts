export type Owner = 'product' | 'sellable';
type Payload =
  | { type: 'text'; value: string }
  | { type: 'boolean'; value: boolean }
  | { type: 'number'; value: number; unit: string | null }
  | { type: 'single'; value: string }
  | { type: 'multi'; value: string[] };
export type EditorialValue = Payload & {
  code: string;
  owner: Owner;
  variantId: string | null;
};
export interface EditorialDocument {
  commercialTitle: string | null;
  description: string | null;
  mediaRefs: string[];
  familyCode: string | null;
  values: EditorialValue[];
}
export type Definition = { code: string; owner: Owner } & (
  | { type: 'text' | 'boolean' }
  | { type: 'number'; units: readonly (string | null)[] }
  | { type: 'single' | 'multi'; codes: readonly string[] }
);
/** Only an authoritative, tenant/product-qualified integration may supply this. */
export interface DocumentAuthority {
  tenantId: string;
  productId: string;
  variantIds: readonly string[];
  assetIds: readonly string[];
  families: readonly { code: string; attributes: readonly Definition[] }[];
}
export function fail(code: string): never {
  throw new Error(code);
}
export function emptyDocument(): EditorialDocument {
  return {
    commercialTitle: null,
    description: null,
    mediaRefs: [],
    familyCode: null,
    values: [],
  };
}
export function closedObject(
  input: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  if (
    !input ||
    typeof input !== 'object' ||
    Array.isArray(input) ||
    Object.getPrototypeOf(input) !== Object.prototype
  )
    fail('MALFORMED');
  const object = input as Record<string, unknown>;
  if (
    Object.keys(object).length !== keys.length ||
    keys.some((key) => !Object.prototype.hasOwnProperty.call(object, key))
  )
    fail('MALFORMED');
  return object;
}
function strings(input: unknown): input is string[] {
  return (
    Array.isArray(input) &&
    Array.from(input).every((v) => typeof v === 'string') &&
    new Set(input).size === input.length
  );
}
export function validateDocument(
  input: unknown,
  authority: DocumentAuthority,
): EditorialDocument {
  const d = closedObject(input, [
    'commercialTitle',
    'description',
    'mediaRefs',
    'familyCode',
    'values',
  ]);
  for (const key of ['commercialTitle', 'description', 'familyCode']) {
    if (d[key] !== null && typeof d[key] !== 'string') fail('MALFORMED');
  }
  if (
    !strings(d.mediaRefs) ||
    d.mediaRefs.some((id) => !authority.assetIds.includes(id))
  )
    fail('MALFORMED');
  if (!Array.isArray(d.values)) fail('MALFORMED');
  const family = authority.families.find((f) => f.code === d.familyCode);
  if (d.familyCode !== null && !family) fail('MALFORMED');
  const seen = new Set<string>();
  for (const raw of d.values) {
    const type =
      raw && typeof raw === 'object'
        ? (raw as Record<string, unknown>).type
        : undefined;
    const v = closedObject(raw, [
      'code',
      'owner',
      'variantId',
      'type',
      'value',
      ...(type === 'number' ? ['unit'] : []),
    ]);
    const definitions =
      family?.attributes.filter((a) => a.code === v.code) ?? [];
    if (definitions.length !== 1) fail('MALFORMED');
    const definition = definitions[0];
    if (v.type !== definition.type || v.owner !== definition.owner)
      fail('MALFORMED');
    const variantRequired =
      v.owner === 'sellable' && authority.variantIds.length > 0;
    if (
      variantRequired
        ? typeof v.variantId !== 'string' ||
          !authority.variantIds.includes(v.variantId)
        : v.variantId !== null
    )
      fail('MALFORMED');
    const binding = JSON.stringify([v.code, v.variantId]);
    if (seen.has(binding)) fail('MALFORMED');
    seen.add(binding);
    switch (definition.type) {
      case 'text':
        if (typeof v.value !== 'string') fail('MALFORMED');
        break;
      case 'boolean':
        if (typeof v.value !== 'boolean') fail('MALFORMED');
        break;
      case 'number':
        if (
          typeof v.value !== 'number' ||
          !Number.isFinite(v.value) ||
          !definition.units.includes(v.unit as string | null)
        )
          fail('MALFORMED');
        break;
      case 'single':
        if (typeof v.value !== 'string' || !definition.codes.includes(v.value))
          fail('MALFORMED');
        break;
      case 'multi':
        if (
          !strings(v.value) ||
          v.value.some((code) => !definition.codes.includes(code))
        )
          fail('MALFORMED');
    }
  }
  return structuredClone(input) as EditorialDocument;
}
