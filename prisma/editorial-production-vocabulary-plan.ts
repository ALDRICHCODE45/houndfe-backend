import {
  buildProductionVocabularyManifest,
  ProductionVocabularyManifest as Manifest,
} from './editorial-production-vocabulary.manifest';

type GlobalKind = 'family' | 'definition';
type ScopedKind = 'option' | 'unit' | 'group' | 'alias' | 'binding';
type Kind = GlobalKind | ScopedKind;
type Primitive = string | number | boolean | null;
type Value = Primitive | Value[] | { [key: string]: Value };
export interface VocabularyIdentity {
  kind: Kind;
  scope: string; // empty for global codes; definition code for children; family for bindings
  code: string; // alias label for aliases; definition code for bindings
}
export interface VocabularyReference extends VocabularyIdentity {
  id?: string; // snapshot references must supply the actual target ID
}
export interface VocabularyEntry extends VocabularyIdentity {
  fields: Record<string, Value>;
  references: VocabularyReference[];
}
export interface VocabularySnapshot {
  semanticsVersion?: string;
  rows: (VocabularyEntry & { id: string })[];
}
export interface VocabularyPlan {
  applicable: boolean;
  metadataAddition?: { semanticsVersion: string };
  additions: (VocabularyEntry & { id?: string })[];
  preservations: VocabularySnapshot['rows'];
  conflicts: { identity: string; reason: string }[];
}
const identity = (row: VocabularyIdentity) =>
  JSON.stringify([row.kind, row.scope, row.code]);
const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, item: unknown) =>
    item && typeof item === 'object' && !Array.isArray(item)
      ? Object.fromEntries(
          Object.entries(item).sort(([a], [b]) => compare(a, b)),
        )
      : item,
  );
const copy = <T>(value: T): T => structuredClone(value);
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sorted = <T extends VocabularyIdentity>(rows: T[]) =>
  rows.sort(
    (a, b) =>
      compare(identity(a), identity(b)) || compare(canonical(a), canonical(b)),
  );
function desiredRows(manifest: Manifest): VocabularyEntry[] {
  const rows: VocabularyEntry[] = [];
  const ref = (kind: Kind, code: string, scope = '') => ({ kind, scope, code });
  const add = (
    kind: Kind,
    code: string,
    fields: Record<string, Value>,
    scope = '',
    references: VocabularyReference[] = [],
  ) => {
    rows.push({ kind, scope, code, fields: copy(fields), references });
  };
  for (const { code, bindings, ...fields } of manifest.families) {
    add('family', code, fields);
    for (const { definitionCode, ...fields } of bindings) {
      add('binding', definitionCode, fields, code, [
        ref('family', code),
        ref('definition', definitionCode),
      ]);
    }
  }
  for (const definition of manifest.definitions) {
    const { code, label, type } = definition;
    add('definition', code, {
      label,
      type,
      ...('numericPolicy' in definition
        ? { numericPolicy: definition.numericPolicy }
        : {}),
    });
    const parent = ref('definition', code);
    if ('units' in definition) {
      for (const { code: unit, ...fields } of definition.units)
        add('unit', unit, fields, code, [parent]);
    }
    if ('options' in definition) {
      for (const { code: option, ...fields } of definition.options)
        add('option', option, fields, code, [parent]);
      for (const group of definition.groups) {
        const members = group.optionCodes.map((option) =>
          ref('option', option, code),
        );
        add('group', group.code, { label: group.label }, code, [
          parent,
          ...members,
        ]);
      }
      for (const { label: alias, optionCode } of definition.aliases) {
        add('alias', alias, {}, code, [
          parent,
          ref('option', optionCode, code),
        ]);
      }
    }
  }
  return sorted(rows);
}

/** Pure dry-run only: no IDs allocated, writes or executable apply batch.
 * Snapshot fields retain all existing metadata/customization; references carry real IDs.
 * Additions without id describe new rows; with id they patch only missing fields/references.
 * Absent reference targets remain symbolic. metadataAddition supplies a missing version.
 * Preservations retain all existing rows/metadata, even omissions and archives.
 * Groups union scoped members, including overlapping/omitted custom groups.
 * applicable=false blocks the WHOLE report, including diagnostic additions; never apply it.
 */
export function planProductionVocabulary(
  snapshot: VocabularySnapshot,
  manifest = buildProductionVocabularyManifest(),
): VocabularyPlan {
  const plan: VocabularyPlan = {
    applicable: true,
    additions: [],
    preservations: [],
    conflicts: [],
  };
  const conflict = (row: VocabularyIdentity, reason: string) => {
    plan.conflicts.push({ identity: identity(row), reason });
  };
  const desired = desiredRows(manifest);
  const indexRows = <T extends VocabularyEntry>(rows: T[]) => {
    const index = new Map<string, T[]>();
    for (const row of rows) {
      const key = identity(row);
      if (index.has(key)) conflict(row, 'duplicate identity');
      index.set(key, [...(index.get(key) ?? []), row]);
    }
    return index;
  };
  const existing = indexRows(snapshot.rows);
  const target = indexRows(desired);
  const ids = new Map<string, string[]>();
  for (const row of snapshot.rows) {
    const namespace = JSON.stringify([row.kind, row.id]);
    ids.set(namespace, [...(ids.get(namespace) ?? []), identity(row)]);
    if (!row.id) conflict(row, 'missing persisted ID');
  }
  for (const row of snapshot.rows) {
    if (new Set(ids.get(JSON.stringify([row.kind, row.id]))).size > 1)
      conflict(row, 'persisted ID resolves multiple rows');
  }
  const validate = (row: VocabularyEntry, persisted: boolean) => {
    const global = (kind: Kind, code: string) =>
      identity({ kind, scope: '', code });
    const expectedParents =
      row.kind === 'binding'
        ? [global('family', row.scope), global('definition', row.code)]
        : ['family', 'definition'].includes(row.kind)
          ? []
          : [global('definition', row.scope)];
    if ((expectedParents.length === 0) !== (row.scope === ''))
      conflict(row, 'invalid scope');
    const seen = new Set<string>();
    for (const reference of row.references) {
      const key = identity(reference);
      if (seen.has(key)) conflict(row, 'duplicate reference');
      seen.add(key);
      const matches = (persisted ? existing : target).get(key);
      if (matches?.length !== 1)
        conflict(row, 'dangling or ambiguous reference: ' + key);
      if (
        persisted &&
        (!reference.id ||
          !existing.get(key)?.some((target) => target.id === reference.id))
      )
        conflict(row, 'reference ID mismatch: ' + key);
      const member =
        reference.kind === 'option' &&
        reference.scope === row.scope &&
        ['group', 'alias'].includes(row.kind);
      if (!expectedParents.includes(key) && !member)
        conflict(row, 'invalid reference role: ' + key);
    }
    if (expectedParents.some((key) => !seen.has(key)))
      conflict(row, 'missing parent reference');
    if (
      row.kind === 'alias' &&
      row.references.filter((r) => r.kind === 'option').length !== 1
    )
      conflict(row, 'alias requires one target');
  };
  snapshot.rows.forEach((row) => validate(row, true));
  desired.forEach((row) => validate(row, false));
  if (snapshot.semanticsVersion === undefined)
    plan.metadataAddition = { semanticsVersion: manifest.semanticsVersion };
  else if (snapshot.semanticsVersion !== manifest.semanticsVersion)
    plan.conflicts.push({
      identity: 'semanticsVersion',
      reason: 'incompatible semantics version',
    });
  const customFields = ['label', 'sortOrder', 'archived', 'archivedAt'];
  for (const row of desired) {
    const matches = existing.get(identity(row));
    if (matches && matches.length > 1) continue;
    const old = matches?.[0];
    const fields: Record<string, Value> = {};
    for (const [field, value] of Object.entries(row.fields)) {
      if (old?.fields.archivedAt && field === 'archived') continue;
      if (!old || !(field in old.fields)) fields[field] = copy(value);
      else if (
        !customFields.includes(field) &&
        canonical(old.fields[field]) !== canonical(value)
      )
        conflict(row, 'incompatible field: ' + field);
    }
    for (const field of Object.keys(old?.fields ?? {})) {
      if (!(field in row.fields) && !customFields.includes(field))
        conflict(row, 'unrecognized semantic field: ' + field);
    }
    const references = row.references
      .filter(
        (reference) =>
          !old?.references.some((r) => identity(r) === identity(reference)),
      )
      .map((reference) => {
        const resolved = existing.get(identity(reference));
        return {
          ...reference,
          ...(resolved?.length === 1 ? { id: resolved[0].id } : {}),
        };
      });
    if (old?.kind === 'alias' && references.length)
      conflict(row, 'alias target reinterpretation');
    if (!old || Object.keys(fields).length || references.length)
      plan.additions.push({
        ...copy(row),
        fields,
        references: sorted(references),
        ...(old ? { id: old.id } : {}),
      });
  }
  plan.preservations = sorted(
    copy(snapshot.rows).map((row) => ({
      ...row,
      references: sorted(row.references),
    })),
  );
  plan.conflicts = [
    ...new Map(plan.conflicts.map((c) => [canonical(c), c])).values(),
  ].sort((a, b) => compare(canonical(a), canonical(b)));
  plan.applicable = plan.conflicts.length === 0;
  return plan;
}
