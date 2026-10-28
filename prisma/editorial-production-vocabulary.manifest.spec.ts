import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { buildProductionVocabularyManifest } from './editorial-production-vocabulary.manifest';

const read = (name: string) => readFileSync(`docs/${name}.md`, 'utf8');
const source = read('editorial-vocabulary-source-snapshot');
const normalized = read('editorial-vocabulary-normalized-proposal');
const mapping = JSON.parse(
  read('catalog-editorial-production-vocabulary-policy-mapping')
    .split('```json\n')[1]
    .split('\n```')[0],
);
type Row = [
  number,
  string,
  string,
  string[],
  'U' | 'M',
  'F' | 'D' | 'I',
  string,
];
const rows: Row[] = JSON.parse(
  normalized.split('```json\n')[1].split('\n```')[0],
);
const families = [
  'food',
  'treat',
  'toy',
  'hygiene',
  'accessory',
  'habitat',
  'care',
];
const expand = (s: string): string[] =>
  ({
    ALL: families,
    DIM: ['toy', 'hygiene', 'accessory', 'habitat', 'care'],
    EQUIP: ['accessory', 'habitat'],
    COVER: ['hygiene', 'habitat'],
  })[s] ?? s.split(',');
const routes = (s: string) =>
  s.split(',').flatMap((token) => {
    const [f, ruleId] = token.split(':');
    return expand(f).map((family) => ({ family, ruleId }));
  });
const exposure = { F: 'FACET', D: 'DETAIL', I: 'INTERNAL' };
const definition = (code: string) =>
  buildProductionVocabularyManifest().definitions.find((d) => d.code === code)!;

it('pins immutable input provenance separately from the three approved overlay options', () => {
  const { provenance } = buildProductionVocabularyManifest();
  expect(provenance.source).toEqual({
    blob: '9538de694f1125e79e5f2b60e2e4eb49b2e0a05d',
    sha256: createHash('sha256').update(source).digest('hex'),
  });
  expect(provenance.normalized).toEqual({
    blob: 'fd89f5a29edb8015f4a361888cbcddfd6098b173',
    sha256: createHash('sha256').update(normalized).digest('hex'),
  });
  expect(provenance.overlay).toEqual({
    authority: 'S7',
    options: mapping.overlay.map(([code, label]) => ({ code, label })),
  });
});

it('exports seven families, 68 definitions, 201 exclusive bindings and 514 + 3 options', () => {
  const m = buildProductionVocabularyManifest();
  expect(m.semanticsVersion).toBe('editorial-production-1');
  expect(m.families.map((f) => f.code)).toEqual(families);
  expect(
    m.families.every(
      (f) => f.label === f.code && f.minimumContractVersion === 2,
    ),
  ).toBe(true);
  expect(m.definitions).toHaveLength(68);
  expect(
    m.definitions.filter((d) => d.type === 'single' || d.type === 'multi'),
  ).toHaveLength(32);
  expect(
    m.definitions.filter((d) => d.type === 'number' || d.type === 'range'),
  ).toHaveLength(25);
  expect(m.definitions.filter((d) => d.type === 'text')).toHaveLength(8);
  expect(m.definitions.filter((d) => d.type === 'boolean')).toHaveLength(3);
  expect(m.families.flatMap((f) => f.bindings)).toHaveLength(201);
  expect(
    m.definitions.flatMap((d) => ('options' in d ? d.options : [])),
  ).toHaveLength(517);
});

it('preserves every immutable source option, label, group and source-order ordinal', () => {
  const expected = new Map<
    string,
    { code: string; label: string; sortOrder: number; archived: false }[]
  >();
  for (const [line, group, code, , type, , pairs] of rows) {
    const d = definition(code);
    expect(d.type).toBe(type === 'U' ? 'single' : 'multi');
    if (!('options' in d)) throw Error(code);
    const options = expected.get(code) ?? [];
    const members = pairs.split('; ').map((pair) => {
      const [key, label] = pair.split('=');
      const optionCode = `${group}.${key}`;
      options.push({
        code: optionCode,
        label,
        sortOrder: options.length,
        archived: false,
      });
      return optionCode;
    });
    expected.set(code, options);
    if (code === 'hygiene.form')
      members.push(...mapping.overlay.map(([c]) => c));
    expect(d.groups.find((g) => g.code === group)).toEqual({
      code: group,
      label: source.split('\n')[line - 1].split('|')[2].trim().split(' · ')[0],
      optionCodes: members,
    });
  }
  expect([...expected.values()].flat()).toHaveLength(514);
  for (const [code, options] of expected) {
    if (code === 'hygiene.form')
      for (const [c, label] of mapping.overlay)
        options.push({
          code: c,
          label,
          sortOrder: options.length,
          archived: false,
        });
    expect(definition(code)).toMatchObject({ options });
  }
  expect(
    buildProductionVocabularyManifest().definitions.flatMap((d) =>
      'groups' in d ? d.groups : [],
    ),
  ).toHaveLength(67);
});

it('uses only approved aliases and one material/shared process/shared texture definition', () => {
  const m = buildProductionVocabularyManifest();
  for (const d of m.definitions)
    if ('aliases' in d)
      expect(d.aliases).toEqual(
        d.code === 'animal.target'
          ? mapping.aliases.map(([label, optionCode]) => ({
              label,
              optionCode,
            }))
          : [],
      );
  for (const code of ['material', 'food.process', 'food.texture'])
    expect(m.definitions.filter((d) => d.code === code)).toHaveLength(1);
  const material = definition('material');
  if (!('groups' in material)) throw Error('material');
  expect(material.groups.map((g) => g.code)).toEqual([
    'material.base',
    'material.rigid',
  ]);
});

it('maps every family/definition once with fixed owner, exposure, search and exact fact dispatch', () => {
  const m = buildProductionVocabularyManifest();
  const expected = new Map<string, unknown>();
  const add = (code: string, e: string, spec: string) => {
    for (const { family, ruleId } of routes(spec))
      expected.set(`${family}:${code}`, {
        definitionCode: code,
        owner: 'sellable',
        searchable: false,
        exposure: exposure[e],
        sortOrder: m.definitions.findIndex((d) => d.code === code),
        publicationCheck:
          [
            'required',
            'animal',
            'form',
            'fit',
            'capacity',
            'space',
            'presentation',
            'dimensions',
            'equipment',
          ].includes(ruleId) ||
          (ruleId === 'content' &&
            ['food', 'treat', 'hygiene', 'care'].includes(family))
            ? 'always'
            : 'when_asserted',
        policy: {
          route: 'fact_rule',
          rule: { family, ruleId, parameter: code },
        },
      });
  };
  for (const [code, spec] of mapping.choices)
    add(code, rows.find((r) => r[2] === code)![5], spec);
  for (const [codes, , , , e, , spec] of mapping.numbers)
    for (const code of codes) add(code, e, spec);
  for (const [code, , fs, e] of mapping.other)
    add(
      code,
      e,
      expand(fs)
        .map((f) => `${f}:optional`)
        .join(','),
    );
  const actual = m.families.flatMap((f) =>
    f.bindings.map((b) => [`${f.code}:${b.definitionCode}`, b] as const),
  );
  expect(actual).toHaveLength(expected.size);
  expect(new Map(actual)).toEqual(expected);
});

it('emits all exact numeric units and resolved positive/count/unbounded domain policies', () => {
  for (const [codes, type, units, , , domain] of mapping.numbers)
    for (const code of codes) {
      expect(definition(code)).toMatchObject({
        type: type === 'N' ? 'number' : 'range',
        units: units.map((u, sortOrder) => ({ code: u, label: u, sortOrder })),
        numericPolicy: {
          status: 'resolved',
          magnitude: code,
          integer: domain === 'I',
          lower: domain === 'F' ? null : 0,
          lowerInclusive: false,
          upper: null,
          upperInclusive: false,
        },
      });
    }
});

it('uses symbolic canonical references, no fabricated persisted IDs or evidence definitions', () => {
  const m = buildProductionVocabularyManifest();
  const codes = [
    ...new Set(rows.map((r) => r[2])),
    ...mapping.numbers.flatMap((r) => r[0]),
    ...mapping.other.map((r) => r[0]),
  ];
  expect(m.definitions.map((d) => d.code)).toEqual(codes);
  expect(m.definitions.every((d) => d.label === d.code)).toBe(true);
  const visit = (v: unknown) => {
    if (v && typeof v === 'object')
      for (const [k, value] of Object.entries(v)) {
        expect(k).not.toMatch(/^(id|definitionId|familyId)$/);
        visit(value);
      }
  };
  visit(m);
});

it('returns deterministic fresh nested objects without leaking caller mutations', () => {
  const first = buildProductionVocabularyManifest();
  const next = buildProductionVocabularyManifest();
  expect(first).toEqual(next);
  const mutate = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    for (const [k, value] of Object.entries(v)) {
      if (value && typeof value === 'object') mutate(value);
      else (v as Record<string, unknown>)[k] = 'caller mutation';
    }
  };
  mutate(first);
  expect(buildProductionVocabularyManifest()).toEqual(next);
});
