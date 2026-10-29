// Symbolic initial defaults: provenance and construction live here.
// Normative rows and choice inventory are owned by pure domain modules.
import {
  FAMILY_CODES,
  CHOICES,
  NUMBERS,
  OTHER,
  ProductionFamily,
  RuleId,
  ProductionDefinitionCode,
} from '../src/catalog-editorial/domain/editorial-production-vocabulary-catalog';
import {
  INVENTORY,
  OVERLAY,
  ALIASES,
} from '../src/catalog-editorial/domain/editorial-production-choice-inventory';
export type {
  ProductionFamily,
  RuleId,
  ProductionDefinitionCode,
} from '../src/catalog-editorial/domain/editorial-production-vocabulary-catalog';
export type ProductionValueType =
  | 'single'
  | 'multi'
  | 'number'
  | 'range'
  | 'text'
  | 'boolean';
type ExposureKey = 'F' | 'D' | 'I';

type Option = {
  code: string;
  label: string;
  sortOrder: number;
  archived: false;
};
type Group = { code: string; label: string; optionCodes: string[] };
type Alias = { label: string; optionCode: string };
type DefinitionBase = { code: ProductionDefinitionCode; label: string };
export type ProductionDefinition = DefinitionBase &
  (
    | {
        type: 'single' | 'multi';
        options: Option[];
        groups: Group[];
        aliases: Alias[];
      }
    | { type: 'text' | 'boolean' }
    | {
        type: 'number' | 'range';
        units: { code: string; label: string; sortOrder: number }[];
        numericPolicy: {
          status: 'resolved';
          magnitude: ProductionDefinitionCode;
          integer: boolean;
          lower: 0 | null;
          lowerInclusive: false;
          upper: null;
          upperInclusive: false;
        };
      }
  );
export type ProductionBinding = {
  definitionCode: ProductionDefinitionCode;
  owner: 'sellable';
  sortOrder: number;
  exposure: 'FACET' | 'DETAIL' | 'INTERNAL';
  searchable: false;
  publicationCheck: 'always' | 'when_asserted';
  policy: {
    route: 'fact_rule';
    rule: {
      family: ProductionFamily;
      ruleId: RuleId;
      parameter: ProductionDefinitionCode;
    };
  };
};
export type ProductionVocabularyManifest = {
  semanticsVersion: 'editorial-production-1';
  provenance: {
    source: { blob: string; sha256: string };
    normalized: { blob: string; sha256: string };
    overlay: { authority: 'S7'; options: { code: string; label: string }[] };
  };
  families: {
    code: ProductionFamily;
    label: string;
    minimumContractVersion: 2;
    bindings: ProductionBinding[];
  }[];
  definitions: ProductionDefinition[];
};

function expandFamilies(token: string): ProductionFamily[] {
  return token === 'ALL'
    ? [...FAMILY_CODES]
    : (token.split(',') as ProductionFamily[]);
}
function publicationCheck(
  family: ProductionFamily,
  rule: RuleId,
): ProductionBinding['publicationCheck'] {
  const always: RuleId[] = [
    'required',
    'animal',
    'form',
    'fit',
    'capacity',
    'space',
    'presentation',
    'dimensions',
    'equipment',
  ];
  return always.includes(rule) ||
    (rule === 'content' &&
      ['food', 'treat', 'hygiene', 'care'].includes(family))
    ? 'always'
    : 'when_asserted';
}

/** Build fresh symbolic initial defaults. No evaluation, ID allocation or apply. */
export function buildProductionVocabularyManifest(): ProductionVocabularyManifest {
  const definitions: ProductionDefinition[] = [];
  const families: ProductionVocabularyManifest['families'] = FAMILY_CODES.map(
    (code) => ({ code, label: code, minimumContractVersion: 2, bindings: [] }),
  );
  const add = (
    definition: ProductionDefinition,
    exposure: ExposureKey,
    spec: string,
  ) => {
    const sortOrder = definitions.length;
    definitions.push(definition);
    for (const token of spec.split(',')) {
      const [familyToken, ruleToken] = token.split(':');
      const ruleId = ruleToken as RuleId;
      for (const family of expandFamilies(familyToken)) {
        families
          .find((f) => f.code === family)!
          .bindings.push({
            definitionCode: definition.code,
            owner: 'sellable',
            sortOrder,
            exposure: ({ F: 'FACET', D: 'DETAIL', I: 'INTERNAL' } as const)[
              exposure
            ],
            searchable: false,
            publicationCheck: publicationCheck(family, ruleId),
            policy: {
              route: 'fact_rule',
              rule: { family, ruleId, parameter: definition.code },
            },
          });
      }
    }
  };
  for (const [code, type, exposure, spec] of CHOICES) {
    const options: Option[] = [];
    const groups: Group[] = [];
    for (const [definitionCode, group, label, pairs] of INVENTORY) {
      if (definitionCode !== code) continue;
      const optionCodes = pairs.split('; ').map((pair) => {
        const separator = pair.indexOf('=');
        const optionCode = `${group}.${pair.slice(0, separator)}`;
        options.push({
          code: optionCode,
          label: pair.slice(separator + 1),
          sortOrder: options.length,
          archived: false,
        });
        return optionCode;
      });
      groups.push({ code: group, label, optionCodes });
    }
    if (code === 'hygiene.form')
      for (const [optionCode, label] of OVERLAY) {
        options.push({
          code: optionCode,
          label,
          sortOrder: options.length,
          archived: false,
        });
        groups[0].optionCodes.push(optionCode);
      }
    const aliases =
      code === 'animal.target'
        ? ALIASES.map(([label, optionCode]) => ({ label, optionCode }))
        : [];
    add({ code, label: code, type, options, groups, aliases }, exposure, spec);
  }
  for (const [code, type, units, exposure, domain, spec] of NUMBERS) {
    add(
      {
        code,
        label: code,
        type,
        units: units
          .split(',')
          .map((unit, sortOrder) => ({ code: unit, label: unit, sortOrder })),
        numericPolicy: {
          status: 'resolved',
          magnitude: code,
          integer: domain === 'I',
          lower: domain === 'F' ? null : 0,
          lowerInclusive: false,
          upper: null,
          upperInclusive: false,
        },
      },
      exposure,
      spec,
    );
  }
  for (const [code, type, familySpec, exposure] of OTHER) {
    add(
      { code, label: code, type },
      exposure,
      expandFamilies(familySpec)
        .map((f) => `${f}:optional`)
        .join(','),
    );
  }
  return {
    semanticsVersion: 'editorial-production-1',
    families,
    definitions,
    provenance: {
      source: {
        blob: '9538de694f1125e79e5f2b60e2e4eb49b2e0a05d',
        sha256:
          '2ce7b92a4866c3693a7a373fe0e1cbc7199b67e0c3a1e66725534fed9c8a8205',
      },
      normalized: {
        blob: 'fd89f5a29edb8015f4a361888cbcddfd6098b173',
        sha256:
          '1dc079543c8607c8d984f548ec22d21c4092f342577c7c2e14dba7c5467488a9',
      },
      overlay: {
        authority: 'S7',
        options: OVERLAY.map(([code, label]) => ({ code, label })),
      },
    },
  };
}
