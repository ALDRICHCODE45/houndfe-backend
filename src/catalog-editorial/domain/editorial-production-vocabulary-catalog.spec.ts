import { readFileSync } from 'node:fs';
import { buildProductionVocabularyManifest } from '../../../prisma/editorial-production-vocabulary.manifest';
import {
  FAMILY_CODES,
  CHOICES,
  NUMBERS,
  OTHER,
  isProductionDefinitionCode,
  isProductionFamily,
  isProductionRuleId,
} from './editorial-production-vocabulary-catalog';

const mapping = JSON.parse(
  readFileSync(
    'docs/catalog-editorial-production-vocabulary-policy-mapping.md',
    'utf8',
  )
    .split('```json\n')[1]
    .split('\n```')[0],
) as {
  choices: [string, string][];
  numbers: [string[], ...unknown[]][];
  other: [string, ...unknown[]][];
};
const codes: string[] = [
  ...mapping.choices.map(([code]) => code),
  ...mapping.numbers.flatMap(([codes]) => codes),
  ...mapping.other.map(([code]) => code),
];
const families = [
  'food',
  'treat',
  'toy',
  'hygiene',
  'accessory',
  'habitat',
  'care',
];
const rules = [
  'required',
  'optional',
  'animal',
  'form',
  'content',
  'dimensions',
  'fit',
  'capacity',
  'space',
  'equipment',
  'optional_equipment',
  'presentation',
];

it.each([
  ['definitions', codes, 68, isProductionDefinitionCode],
  ['families', families, 7, isProductionFamily],
  ['rules', rules, 12, isProductionRuleId],
] as const)(
  'accepts exact %s without normalization or duplicates',
  (_, values, count, accepts) => {
    expect(values).toHaveLength(count);
    expect(new Set(values).size).toBe(count);
    for (const value of values) {
      expect(accepts(value)).toBe(true);
      for (const invalid of [
        value.toUpperCase(),
        ` ${value}`,
        `${value}\n`,
        `${value}.extra`,
        value.slice(0, -1),
      ])
        expect(accepts(invalid)).toBe(false);
    }
  },
);

it('freezes exported tables and rows against caller mutation', () => {
  for (const table of [FAMILY_CODES, CHOICES, NUMBERS, OTHER]) {
    expect(Object.isFrozen(table)).toBe(true);
    expect(Reflect.set(table, 0, 'changed')).toBe(false);
  }
  for (const row of [...CHOICES, ...NUMBERS, ...OTHER]) {
    expect(Object.isFrozen(row)).toBe(true);
    expect(Reflect.set(row, 0, 'changed')).toBe(false);
    expect(isProductionDefinitionCode(row[0])).toBe(true);
  }
});

it('rejects child-only identities and nonstrings in every namespace', () => {
  const children = buildProductionVocabularyManifest().definitions.flatMap(
    (d) =>
      'options' in d ? [...d.options, ...d.groups].map((row) => row.code) : [],
  );
  for (const accepts of [
    isProductionDefinitionCode,
    isProductionFamily,
    isProductionRuleId,
  ])
    for (const invalid of [
      // Some group codes equal definition codes; those strings remain members.
      ...children.filter((code) => !codes.includes(code)),
      '',
      'measure',
      'food.',
      null,
      undefined,
      1,
      true,
      [],
      {},
      Object('food'),
    ])
      expect(accepts(invalid)).toBe(false);
});
