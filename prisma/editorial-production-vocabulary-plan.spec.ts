import { buildProductionVocabularyManifest } from './editorial-production-vocabulary.manifest';
import {
  planProductionVocabulary,
  VocabularyEntry,
  VocabularyIdentity,
  VocabularySnapshot,
  VocabularyPlan,
} from './editorial-production-vocabulary-plan';

const key = (row: VocabularyIdentity) =>
  JSON.stringify([row.kind, row.scope, row.code]);
const source = buildProductionVocabularyManifest();
const choice = source.definitions.find((d) => d.code === 'animal.target')!;
const numeric = source.definitions.find((d) => d.code === 'measure.net_mass')!;
const manifest = structuredClone(source);
manifest.families = manifest.families.slice(0, 1);
manifest.families[0].bindings = manifest.families[0].bindings.filter((b) =>
  [choice.code, numeric.code].includes(b.definitionCode),
);
manifest.definitions = manifest.definitions.filter((d) =>
  [choice.code, numeric.code].includes(d.code),
);
for (const definition of manifest.definitions) {
  if ('options' in definition) {
    definition.options = definition.options.slice(0, 2);
    definition.groups = definition.groups.slice(0, 1);
    definition.groups[0].optionCodes = definition.options.map((o) => o.code);
    definition.aliases = [
      { label: 'custom alias', optionCode: definition.options[0].code },
    ];
  }
  if ('units' in definition) definition.units = definition.units.slice(0, 1);
}
function run(snapshot: VocabularySnapshot, desired = manifest) {
  const before = structuredClone({ snapshot, desired });
  const result = planProductionVocabulary(snapshot, desired);
  expect({ snapshot, desired }).toEqual(before);
  return result;
}
function full(desired = manifest): VocabularySnapshot {
  const rows = run({ rows: [] }, desired).additions.map((row, i) => ({
    ...row,
    id: `persisted-${i}`,
  }));
  for (const row of rows) {
    row.references = row.references.map((ref) => ({
      ...ref,
      id: rows.find((r) => key(r) === key(ref))!.id,
    }));
  }
  return { semanticsVersion: desired.semanticsVersion, rows };
}
const rowOf = (snapshot: VocabularySnapshot, kind: VocabularyEntry['kind']) =>
  snapshot.rows.find((r) => r.kind === kind)!;
function changeId(
  snapshot: VocabularySnapshot,
  row: VocabularySnapshot['rows'][number],
  id: string,
) {
  row.id = id;
  for (const entry of snapshot.rows)
    for (const ref of entry.references) {
      if (key(ref) === key(row)) ref.id = id;
    }
}
function expectPlan(
  snapshot: VocabularySnapshot,
  additions: VocabularyPlan['additions'] = [],
  conflicts: VocabularyPlan['conflicts'] = [],
  desired = manifest,
) {
  const plan = run(snapshot, desired);
  expect(plan).toEqual({
    applicable: !conflicts.length,
    additions,
    preservations: snapshot.rows,
    conflicts,
  });
  return plan;
}
function expectCounts(
  plan: VocabularyPlan,
  additions: number,
  rows: number,
  conflicts = 0,
) {
  expect(plan.applicable).toBe(conflicts === 0);
  expect(plan.additions).toHaveLength(additions);
  expect(plan.preservations).toHaveLength(rows);
  expect(plan.conflicts).toHaveLength(conflicts);
}

describe('pure production vocabulary planner', () => {
  it('reports the complete default manifest with symbolic references and no IDs', () => {
    const plan = run({ rows: [] }, source);
    const count = (kind: VocabularyEntry['kind']) =>
      plan.additions.filter((r) => r.kind === kind).length;
    const kinds: VocabularyEntry['kind'][] = [
      'family',
      'definition',
      'option',
      'binding',
      'group',
      'alias',
      'unit',
    ];
    expect(kinds.map(count)).toEqual([7, 68, 517, 201, 67, 8, 53]);
    expect(plan).toMatchObject({
      applicable: true,
      metadataAddition: { semanticsVersion: source.semanticsVersion },
      preservations: [],
      conflicts: [],
    });
    expect(
      plan.additions.every(
        (r) => !('id' in r) && r.references.every((ref) => !('id' in ref)),
      ),
    ).toBe(true);
    expect(planProductionVocabulary({ rows: [] })).toEqual(plan);
  });

  it('is idempotent for an exact full snapshot and returns fresh independent data', () => {
    const snapshot = full(source);
    const plan = expectPlan(snapshot, [], [], source);
    plan.preservations[0].fields.label = 'changed result';
    expect(run(snapshot, source)).not.toEqual(plan);
    const empty = run({ rows: [] });
    empty.additions[0].fields.label = 'changed addition';
    expect(run({ rows: [] })).not.toEqual(empty);
  });

  it('retains custom labels, ordering, archive timestamps and omitted entries', () => {
    const snapshot = full();
    for (const row of snapshot.rows)
      Object.assign(row.fields, {
        label: 'Custom',
        sortOrder: 99,
        archived: true,
        archivedAt: '2025-01-01',
      });
    delete rowOf(snapshot, 'option').fields.archived;
    for (const kind of ['option', 'alias', 'group'] as const) {
      snapshot.rows.push({
        ...structuredClone(rowOf(snapshot, kind)),
        code: 'omitted',
        id: `extra-${kind}`,
      });
    }
    const result = run(snapshot);
    expectCounts(result, 0, 13);
    expect(result.preservations).toEqual(expect.arrayContaining(snapshot.rows));
  });

  it('unions group memberships, retaining an omitted overlapping custom group', () => {
    const snapshot = full();
    const group = rowOf(snapshot, 'group');
    const extra = {
      ...structuredClone(group),
      code: 'extra-group',
      id: 'extra-group-id',
    };
    snapshot.rows.push(extra);
    const result = run(snapshot);
    expectCounts(result, 0, 11);
    expect(result.preservations).toEqual(
      expect.arrayContaining([group, extra]),
    );
    group.references = group.references.filter((r) => r.kind !== 'option');
    expect(run(snapshot).additions).toEqual([
      {
        ...group,
        fields: {},
        references: extra.references.filter((r) => r.kind === 'option'),
      },
    ]);
  });

  it('qualifies persisted IDs by entity kind but rejects collisions within a kind', () => {
    const snapshot = full();
    const family = rowOf(snapshot, 'family');
    const definition = rowOf(snapshot, 'definition');
    changeId(snapshot, definition, family.id);
    expectPlan(snapshot);
    const options = snapshot.rows.filter((r) => r.kind === 'option');
    changeId(snapshot, options[1], options[0].id);
    expectPlan(
      snapshot,
      [],
      options.map((r) => ({
        identity: key(r),
        reason: 'persisted ID resolves multiple rows',
      })),
    );
  });

  it.each([
    ['definition', 'type', 'text'],
    ['definition', 'numericPolicy', { status: 'pending' }],
    ['binding', 'owner', 'product'],
    ['binding', 'exposure', 'INTERNAL'],
    ['binding', 'policy', { route: 'pending' }],
    ['binding', 'publicationCheck', 'when_asserted'],
    ['binding', 'searchable', true],
    ['family', 'minimumContractVersion', 1],
  ] as const)('blocks incompatible %s.%s', (kind, field, value) => {
    const snapshot = full();
    const row =
      field === 'numericPolicy'
        ? snapshot.rows.find((r) => 'numericPolicy' in r.fields)!
        : rowOf(snapshot, kind);
    row.fields[field] = value;
    expectPlan(
      snapshot,
      [],
      [{ identity: key(row), reason: 'incompatible field: ' + field }],
    );
  });

  it('blocks alias retargeting rather than overwriting it', () => {
    const snapshot = full();
    const alias = rowOf(snapshot, 'alias');
    const target = alias.references[1];
    const option = snapshot.rows.find(
      (r) => r.kind === 'option' && r.code !== target.code,
    )!;
    alias.references[1] = { ...target, code: option.code, id: option.id };
    const result = run(snapshot);
    expect(result.conflicts).toEqual([
      { identity: key(alias), reason: 'alias target reinterpretation' },
    ]);
    expectCounts(result, 1, 10, 1);
  });

  it('resolves partial existing IDs and reports explicit field patches and new rows', () => {
    const snapshot = full();
    snapshot.rows = snapshot.rows.filter((r) =>
      ['family', 'definition'].includes(r.kind),
    );
    const family = rowOf(snapshot, 'family');
    delete family.fields.minimumContractVersion;
    const result = run(snapshot);
    expect(result).toMatchObject({
      applicable: true,
      preservations: snapshot.rows,
      conflicts: [],
    });
    expect(result.additions).toHaveLength(8);
    expect(result.additions.find((r) => r.kind === 'family')).toEqual({
      ...family,
      fields: { minimumContractVersion: 2 },
    });
    for (const row of result.additions.filter((r) => r.kind !== 'family')) {
      expect(row.id).toBeUndefined();
      for (const ref of row.references)
        expect(ref.id).toBe(snapshot.rows.find((r) => key(r) === key(ref))?.id);
    }
  });

  it.each([
    ['duplicate', 0, 11, 3],
    ['dangling', 1, 10, 2],
    ['wrong ID', 0, 10, 1],
    ['cross-definition', 1, 10, 3],
    ['duplicate reference', 0, 10, 1],
  ] as const)(
    'blocks %s references/identities deterministically',
    (caseName, additions, rows, conflicts) => {
      const snapshot = full();
      const group = rowOf(snapshot, 'group');
      if (caseName === 'duplicate')
        snapshot.rows.push({
          ...rowOf(snapshot, 'family'),
          id: 'duplicate-id',
        });
      if (caseName === 'dangling') group.references[1].code = 'missing';
      if (caseName === 'wrong ID') group.references[1].id = 'wrong';
      if (caseName === 'cross-definition')
        group.references[1].scope = numeric.code;
      if (caseName === 'duplicate reference')
        group.references.push(structuredClone(group.references[1]));
      const plan = run(snapshot);
      expectCounts(plan, additions, rows, conflicts);
      const reordered = structuredClone(snapshot);
      reordered.rows.reverse().forEach((r) => r.references.reverse());
      expect(run(reordered)).toEqual(plan);
    },
  );

  it('is stable across equivalent manifest/snapshot ordering and duplicate manifest rows', () => {
    const snapshot = full();
    const reversed = structuredClone(manifest);
    reversed.definitions.reverse();
    reversed.families[0].bindings.reverse();
    const plan = run(snapshot);
    snapshot.rows.reverse().forEach((r) => r.references.reverse());
    expect(run(snapshot, reversed)).toEqual(plan);
    reversed.families.push(structuredClone(reversed.families[0]));
    const blocked = run(snapshot, reversed);
    expectCounts(blocked, 0, 10, 5);
  });
});
