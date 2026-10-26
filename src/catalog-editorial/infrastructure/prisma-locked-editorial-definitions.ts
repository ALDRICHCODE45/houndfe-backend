import { Prisma } from '@prisma/client';
import { closedObject, fail, Owner } from '../domain/document';
import type {
  EditorialDefinitionsSnapshot,
  PersistedEditorialDefinition,
} from '../domain/editorial-definitions';

type CapturedJson =
  | null
  | string
  | boolean
  | number
  | CapturedJson[]
  | { [key: string]: CapturedJson };
function capture(value: unknown, ancestors = new Set<object>()): CapturedJson {
  if (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  )
    return value;
  if (!value || typeof value !== 'object' || ancestors.has(value))
    return fail('MALFORMED');
  const array = Array.isArray(value);
  if (
    Object.getPrototypeOf(value) !==
    (array ? Array.prototype : Object.prototype)
  )
    return fail('MALFORMED');
  ancestors.add(value);
  const entries = Reflect.ownKeys(value)
    .filter((key) => !(array && key === 'length'))
    .map((key) => {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (
        typeof key !== 'string' ||
        !descriptor?.enumerable ||
        !('value' in descriptor)
      )
        return fail('MALFORMED');
      return [key, capture(descriptor.value, ancestors)] as const;
    });
  ancestors.delete(value);
  if (!array) return Object.fromEntries(entries);
  if (
    entries.length !== value.length ||
    entries.some(([key], index) => key !== String(index))
  )
    return fail('MALFORMED');
  return entries.map(([, item]) => item);
}
const either = (predicates: Prisma.Sql[]) =>
  predicates.length ? Prisma.join(predicates, ' OR ') : Prisma.sql`FALSE`;

/** Caller must validate the same captured documents and retain this transaction through its write. */
export async function readLockedEditorialDefinitions(
  tx: Prisma.TransactionClient,
  documents: readonly unknown[],
): Promise<EditorialDefinitionsSnapshot> {
  // Capture JSON data descriptors without executing getters or toJSON methods.
  const captured = capture(documents);
  if (!Array.isArray(captured)) return fail('MALFORMED');
  const docs = captured.map((input) =>
    closedObject(input, [
      'commercialTitle',
      'description',
      'mediaRefs',
      'familyCode',
      'values',
    ]),
  );
  const familyCodes: string[] = [];
  const selectors = docs.flatMap((d) => {
    if (
      !Array.isArray(d.values) ||
      (d.familyCode !== null && typeof d.familyCode !== 'string')
    )
      return fail('MALFORMED');
    const familyCode = d.familyCode;
    if (familyCode === null) {
      if (d.values.length) fail('MALFORMED');
      return [];
    }
    familyCodes.push(familyCode);
    return d.values.map((raw: unknown) => {
      if (!raw || typeof raw !== 'object') return fail('MALFORMED');
      const v = raw as Record<string, unknown>;
      if (
        typeof v.code !== 'string' ||
        typeof v.type !== 'string' ||
        !['text', 'boolean', 'number', 'single', 'multi'].includes(v.type)
      )
        return fail('MALFORMED');
      const options =
        v.type === 'single' ? [v.value] : v.type === 'multi' ? v.value : [];
      if (!Array.isArray(options) || options.some((o) => typeof o !== 'string'))
        return fail('MALFORMED');
      if (v.type === 'number' && v.unit !== null && typeof v.unit !== 'string')
        return fail('MALFORMED');
      return {
        familyCode,
        code: v.code,
        options: options as string[],
        units: v.type === 'number' ? [v.unit as string | null] : [],
      };
    });
  });
  const families = await tx.$queryRaw<
    { id: string; code: string }[]
  >(Prisma.sql`
    SELECT id, code FROM editorial_families WHERE ${either(familyCodes.map((code) => Prisma.sql`code = ${code}`))} ORDER BY id FOR SHARE`);
  const definitions = await tx.$queryRaw<
    { id: string; code: string; type: PersistedEditorialDefinition['type'] }[]
  >(Prisma.sql`
    SELECT id, code, type FROM editorial_definitions WHERE ${either(selectors.map((s) => Prisma.sql`code = ${s.code}`))} ORDER BY id FOR SHARE`);
  if (
    families.length !== new Set(familyCodes).size ||
    definitions.length !== new Set(selectors.map((s) => s.code)).size
  )
    fail('MALFORMED');
  const selected = selectors.map((s) => {
    const family = families.find((f) => f.code === s.familyCode);
    const definition = definitions.find((d) => d.code === s.code);
    if (!family || !definition) return fail('MALFORMED');
    return { ...s, familyId: family.id, definitionId: definition.id };
  });
  const bindings = await tx.$queryRaw<
    { familyId: string; definitionId: string; owner: Owner }[]
  >(Prisma.sql`
    SELECT "familyId", "definitionId", owner FROM editorial_bindings
    WHERE ${either(selected.map((s) => Prisma.sql`("familyId" = ${s.familyId} AND "definitionId" = ${s.definitionId})`))}
    ORDER BY "familyId", "definitionId" FOR SHARE`);
  const options = await tx.$queryRaw<
    { definitionId: string; code: string; archived: boolean }[]
  >(Prisma.sql`
    SELECT "definitionId", code, "archivedAt" IS NOT NULL AS archived FROM editorial_options
    WHERE ${either(selected.flatMap((s) => s.options.map((code) => Prisma.sql`("definitionId" = ${s.definitionId} AND code = ${code})`)))}
    ORDER BY "definitionId", code FOR SHARE`);
  const units = await tx.$queryRaw<
    { definitionId: string; unitCode: string | null }[]
  >(Prisma.sql`
    SELECT "definitionId", "unitCode" FROM editorial_units
    WHERE ${either(selected.flatMap((s) => s.units.map((unit) => Prisma.sql`("definitionId" = ${s.definitionId} AND "unitCode" IS NOT DISTINCT FROM ${unit})`)))}
    ORDER BY id FOR SHARE`);
  for (const s of selected) {
    if (
      !bindings.some(
        (b) => b.familyId === s.familyId && b.definitionId === s.definitionId,
      ) ||
      s.options.some(
        (code) =>
          !options.some(
            (o) => o.definitionId === s.definitionId && o.code === code,
          ),
      ) ||
      s.units.some(
        (unit) =>
          !units.some(
            (u) => u.definitionId === s.definitionId && u.unitCode === unit,
          ),
      )
    )
      fail('MALFORMED');
  }
  return {
    families: families.map((f) => ({
      ...f,
      bindings: bindings
        .filter((b) => b.familyId === f.id)
        .map((b) => ({ definitionId: b.definitionId, owner: b.owner })),
    })),
    definitions: definitions.map((d): PersistedEditorialDefinition => {
      switch (d.type) {
        case 'text':
        case 'boolean':
          return { ...d, type: d.type };
        case 'number':
          return {
            ...d,
            type: d.type,
            units: units
              .filter((u) => u.definitionId === d.id)
              .map((u) => u.unitCode),
          };
        case 'single':
        case 'multi':
          return {
            ...d,
            type: d.type,
            options: options
              .filter((o) => o.definitionId === d.id)
              .map((o) => ({ code: o.code, archived: o.archived })),
          };
        default:
          return fail('MALFORMED');
      }
    }),
  };
}
