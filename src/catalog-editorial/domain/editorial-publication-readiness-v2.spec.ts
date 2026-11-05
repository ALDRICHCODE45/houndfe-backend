import { buildProductionVocabularyManifest } from '../../../prisma/editorial-production-vocabulary.manifest';
import { conserveArchivedOptionsV2 } from './editorial-archived-option-conservation-v2';
import { assertCarePublicationReadinessV2 } from './editorial-care-publication-readiness-v2';
import type { CareReviewCaptureV2 } from './editorial-care-capture-shape-v2';
import { assertContentKindAgreementV2 } from './editorial-content-kind-agreement-v2';
import type { DeclarationShapeV2 } from './editorial-declaration-shape-v2';
import type { DocumentShapeV2 } from './editorial-document-shape-v2';
import { assertEditorialEvaluationReadinessV2 } from './editorial-evaluation-readiness-v2';
import { assertFactConsistencyV2 } from './editorial-fact-consistency-v2';
import { admitFreshDocumentV2 } from './editorial-fresh-document-admission-v2';
import {
  evaluatePublicationReadinessV2 as evaluate,
  type PublicationProblemV2,
  type PublicationReadinessInputV2,
} from './editorial-publication-readiness-v2';
import { assertToyDeterminationAgreementV2 } from './editorial-toy-determination-agreement-v2';
import type { ValueV2 } from './editorial-value-shape-v2';
import { validateFullProductionVocabularyV2 } from './editorial-vocabulary-full-production-v2';
import type { VocabularyV2 } from './editorial-vocabulary-shape-v2';

const evidence = {
  sourceRef: 'Etiqueta del empaque',
  verifiedOn: '2026-11-01',
};

function vocabulary(): VocabularyV2 {
  const manifest = buildProductionVocabularyManifest();
  const definitions = manifest.definitions.map((d, i) => ({
    ...d,
    id: `db/${i}`,
  }));
  return validateFullProductionVocabularyV2({
    semanticsVersion: manifest.semanticsVersion,
    definitions,
    families: manifest.families.map((f) => ({
      id: `family/${f.code}`,
      code: f.code,
      label: f.label,
      bindings: f.bindings.map((b) => ({
        ...b,
        definitionId: definitions.find((d) => d.code === b.definitionCode)!.id,
      })),
    })),
  });
}

function known(
  code: string,
  payload: Extract<ValueV2, { state: 'known' }>['payload'],
  variantId: string | null = null,
  withEvidence = true,
): ValueV2 {
  return {
    code,
    owner: 'sellable',
    variantId,
    state: 'known',
    payload,
    evidence: withEvidence ? { ...evidence } : null,
  };
}
function declaration<K extends DeclarationShapeV2['key']>(
  key: K,
  value: Extract<DeclarationShapeV2, { key: K; state: 'known' }>['value'],
): DeclarationShapeV2 {
  return {
    key,
    state: 'known',
    value,
    evidence: { ...evidence },
    basis: 'Dice el empaque',
  } as DeclarationShapeV2;
}
function readyFood(variantId: string | null = null): DocumentShapeV2 {
  return {
    schemaVersion: 2,
    commercialTitle: 'Croquetas para perro adulto 2 kg',
    description: null,
    mediaRefs: [],
    familyCode: 'food',
    values: [
      known(
        'animal.target',
        { type: 'multi', value: ['ani.dom.dog'] },
        variantId,
      ),
      known(
        'food.format',
        { type: 'single', value: 'food.format.kibble' },
        variantId,
      ),
      known(
        'measure.net_mass',
        { type: 'number', value: 2, unit: 'kg' },
        variantId,
      ),
    ],
    facts: [
      {
        variantId,
        presentation: 'Bolsa de 2 kg',
        declarations: [declaration('contentMagnitude', 'mass')],
        careReview: null,
      },
    ],
  };
}
function readyReview(): Extract<CareReviewCaptureV2, { state: 'prepared' }> {
  return {
    state: 'prepared',
    jurisdiction: 'MX',
    intendedUse: 'Limpieza de oídos',
    determination: 'identified',
    basis: 'Revisión de la etiqueta',
    evidence: [{ ...evidence }],
    requirements: [
      {
        key: 'r',
        description: 'Registro sanitario',
        disposition: 'satisfied',
        evidence: [{ ...evidence }],
        basis: 'Número en el empaque',
      },
    ],
    warnings: [
      {
        key: 'w',
        requirementKeys: ['r'],
        text: 'No usar en heridas',
        disclosure: 'private_only',
        evidence: [{ ...evidence }],
        handlingBasis: 'Se maneja en mostrador',
      },
    ],
  };
}
function readyCare(
  review: CareReviewCaptureV2 | null = readyReview(),
): DocumentShapeV2 {
  return {
    schemaVersion: 2,
    commercialTitle: 'Limpiador ótico 120 ml',
    description: null,
    mediaRefs: [],
    familyCode: 'care',
    values: [
      known('care.type', { type: 'single', value: 'care.type.grooming' }),
      known('care.form', { type: 'single', value: 'care.form.solution' }),
      known('measure.net_volume', { type: 'number', value: 120, unit: 'ml' }),
    ],
    facts: [
      {
        variantId: null,
        presentation: 'Frasco de 120 ml',
        declarations: [
          declaration('contentMagnitude', 'volume'),
          declaration('presentationKind', 'formulation'),
        ],
        careReview: review,
      },
    ],
  };
}
function input(
  document: DocumentShapeV2,
  overrides: Partial<PublicationReadinessInputV2> = {},
): PublicationReadinessInputV2 {
  return {
    document,
    references: { variantIds: [], assetIds: ['asset'] },
    vocabulary: vocabulary(),
    offeredSubjects: [null],
    publishedDocument: null,
    ...overrides,
  };
}
const item = (
  problem: PublicationProblemV2['problem'],
  definitionCode: string | null = null,
  variantId: string | null = null,
  scope: PublicationProblemV2['scope'] = definitionCode
    ? 'definition'
    : 'product',
  detail: string | null = null,
): PublicationProblemV2 => ({
  scope,
  definitionCode,
  variantId,
  problem,
  detail,
});

/** The throwing publication chain: every gate the publish writer runs, in order. */
function publishChainPasses(value: PublicationReadinessInputV2): boolean {
  const { document, references, vocabulary: v, offeredSubjects } = value;
  try {
    const facts = admitFreshDocumentV2(document, references, v, 'publish');
    if (offeredSubjects.length === 0 || document.familyCode === null)
      return false;
    conserveArchivedOptionsV2(document, value.publishedDocument, references, v);
    const family = v.families.find((f) => f.code === document.familyCode)!;
    assertEditorialEvaluationReadinessV2(
      family,
      document.values,
      offeredSubjects,
      facts,
    );
    for (const subject of offeredSubjects) {
      const subjectFacts = facts.get(subject) ?? {};
      assertFactConsistencyV2(subjectFacts);
      assertContentKindAgreementV2(
        document.values.find(
          (x) => x.code === 'content.kind' && x.variantId === subject,
        ),
        subjectFacts.contentMagnitude,
      );
      const toy = document.values.find(
        (x) => x.code === 'toy.type' && x.variantId === subject,
      );
      if (
        family.code === 'toy' &&
        toy?.state === 'known' &&
        toy.payload.type === 'multi'
      )
        assertToyDeterminationAgreementV2(
          toy.payload.value,
          subjectFacts.relevantDimensionCodes,
        );
      if (family.code === 'care')
        assertCarePublicationReadinessV2(
          document.facts.find((row) => row.variantId === subject)?.careReview,
        );
    }
    return true;
  } catch (error) {
    if ((error as Error).message === 'MALFORMED') return false;
    throw error;
  }
}
function expectAgreement(value: PublicationReadinessInputV2) {
  const problems = evaluate(value);
  expect(publishChainPasses(value)).toBe(problems.length === 0);
  return problems;
}

describe('evaluatePublicationReadinessV2', () => {
  it('returns no problems for a complete food draft', () => {
    expect(expectAgreement(input(readyFood()))).toEqual([]);
  });

  it('returns no problems for a complete care draft with a ready review', () => {
    expect(expectAgreement(input(readyCare()))).toEqual([]);
  });

  it('REQUIRED_MISSING: names the missing required definition', () => {
    const d = readyFood();
    d.values = d.values.filter((v) => v.code !== 'measure.net_mass');
    expect(expectAgreement(input(d))).toEqual([
      item('REQUIRED_MISSING', 'measure.net_mass'),
    ]);
  });

  it('REQUIRED_MISSING: blank title and missing family are product items', () => {
    const blank = readyFood();
    blank.commercialTitle = '   ';
    expect(expectAgreement(input(blank))).toEqual([
      item('REQUIRED_MISSING', null, null, 'product', 'commercialTitle'),
    ]);
    const none: DocumentShapeV2 = {
      ...readyFood(),
      familyCode: null,
      values: [],
      facts: [],
    };
    const problems = expectAgreement(input(none));
    expect(problems).toEqual([
      expect.objectContaining({
        scope: 'product',
        problem: 'REQUIRED_MISSING',
        detail: 'familyCode',
      }),
    ]);
  });

  it('collects every problem instead of stopping at the first one', () => {
    const d = readyFood();
    d.commercialTitle = null;
    d.values = [
      { ...d.values[0], state: 'not_applicable', evidence: null } as ValueV2,
      { ...d.values[1], evidence: null } as ValueV2,
    ];
    const problems = expectAgreement(input(d));
    expect(problems).toEqual(
      expect.arrayContaining([
        item('REQUIRED_MISSING', null, null, 'product', 'commercialTitle'),
        item('NA_NOT_ALLOWED', 'animal.target'),
        item('EVIDENCE_REQUIRED', 'food.format'),
        item('REQUIRED_MISSING', 'measure.net_mass'),
      ]),
    );
    expect(problems).toHaveLength(4);
  });

  it('UNRESOLVED: an unknown content magnitude leaves the content rules open', () => {
    const d = readyFood();
    d.facts[0].declarations = [];
    expect(expectAgreement(input(d))).toEqual([
      item('UNRESOLVED', 'measure.net_mass'),
      item('UNRESOLVED', 'measure.net_volume'),
      item('UNRESOLVED', 'measure.content_count'),
    ]);
  });

  it('EVIDENCE_REQUIRED: a known value without its source', () => {
    const d = readyFood();
    d.values[1] = { ...d.values[1], evidence: null } as ValueV2;
    expect(expectAgreement(input(d))).toEqual([
      item('EVIDENCE_REQUIRED', 'food.format'),
    ]);
  });

  it('EVIDENCE_REQUIRED: a supplied but no longer valid source', () => {
    const d = readyFood();
    d.values[1] = {
      ...d.values[1],
      evidence: { sourceRef: ' ', verifiedOn: '2026-11-01' },
    } as ValueV2;
    expect(expectAgreement(input(d))).toEqual([
      item('EVIDENCE_REQUIRED', 'food.format'),
    ]);
  });

  it('NA_NOT_ALLOWED: a required definition marked as not applicable', () => {
    const d = readyFood();
    d.values[0] = {
      ...d.values[0],
      state: 'not_applicable',
      evidence: null,
    } as ValueV2;
    expect(expectAgreement(input(d))).toEqual([
      item('NA_NOT_ALLOWED', 'animal.target'),
    ]);
  });

  it('NOT_APPLICABLE_VALUE: a known value the facts make not applicable', () => {
    const d: DocumentShapeV2 = {
      ...readyFood(),
      familyCode: 'hygiene',
      values: [
        known('hygiene.type', {
          type: 'single',
          value: firstOption('hygiene.type'),
        }),
        known('hygiene.form', {
          type: 'single',
          value: firstOption('hygiene.form'),
        }),
      ],
      facts: [
        {
          variantId: null,
          presentation: 'Pieza',
          declarations: [
            declaration('consumable', false),
            declaration('animalApplied', false),
          ],
          careReview: null,
        },
      ],
    };
    expect(expectAgreement(input(d))).toEqual([
      item('NOT_APPLICABLE_VALUE', 'hygiene.form'),
    ]);
  });

  it('MAGNITUDE_MISMATCH: content kind disagrees with the content magnitude', () => {
    const d = readyFood();
    d.values.push(
      known('content.kind', { type: 'single', value: 'content.kind.volume' }),
    );
    expect(expectAgreement(input(d))).toEqual([
      item('MAGNITUDE_MISMATCH', 'content.kind'),
    ]);
  });

  it('checks content kind per offered subject, never borrowing a sibling', () => {
    const d = readyFood('a');
    d.values.push(
      known(
        'content.kind',
        { type: 'single', value: 'content.kind.mass' },
        'a',
      ),
      known(
        'content.kind',
        { type: 'single', value: 'content.kind.mass' },
        'b',
      ),
    );
    const problems = expectAgreement(
      input(d, {
        references: { variantIds: ['a', 'b'], assetIds: [] },
        offeredSubjects: ['a', 'b'],
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        item('UNRESOLVED', 'content.kind', 'b'),
        item('REQUIRED_MISSING', 'animal.target', 'b'),
      ]),
    );
    expect(problems.filter((p) => p.variantId === 'a')).toEqual([]);
  });

  it('ignores incomplete variants that are not offered', () => {
    const d = readyFood('a');
    expect(
      expectAgreement(
        input(d, {
          references: { variantIds: ['a', 'inactive'], assetIds: [] },
          offeredSubjects: ['a'],
        }),
      ),
    ).toEqual([]);
  });

  it('NUMERIC_POLICY_PENDING: a numeric value whose policy is not resolved', () => {
    const v = vocabulary();
    const definition = v.definitions.find((d) => d.code === 'measure.net_mass');
    if (definition?.type !== 'number') throw new Error('fixture');
    definition.numericPolicy = { status: 'pending' };
    expect(expectAgreement(input(readyFood(), { vocabulary: v }))).toEqual([
      item('NUMERIC_POLICY_PENDING', 'measure.net_mass'),
    ]);
  });

  it('INVALID_VALUE: a numeric value outside its policy', () => {
    const d = readyFood();
    d.values[2] = known('measure.net_mass', {
      type: 'number',
      value: 0,
      unit: 'kg',
    });
    expect(expectAgreement(input(d))).toEqual([
      item('INVALID_VALUE', 'measure.net_mass'),
    ]);
  });

  it('NO_OFFERED_PRESENTATION: an empty E blocks even a complete draft', () => {
    expect(
      expectAgreement(input(readyFood(), { offeredSubjects: [] })),
    ).toEqual([item('NO_OFFERED_PRESENTATION')]);
  });

  it('TOY_TYPES_MISMATCH: the dimension determination covers other toy types', () => {
    const d = toy(['toy.type.rope']);
    expect(expectAgreement(input(d))).toEqual([
      item('TOY_TYPES_MISMATCH', 'toy.type'),
    ]);
    expect(expectAgreement(input(toy(['toy.type.ball'])))).toEqual([]);
  });

  it('UNRESOLVED: a toy without its dimension determination', () => {
    const d = toy(null);
    const problems = expectAgreement(input(d));
    expect(problems).toEqual(
      expect.arrayContaining([item('UNRESOLVED', 'toy.type')]),
    );
  });

  it('FACTS_CONFLICT: a negative relevance with a nonempty subset', () => {
    const d: DocumentShapeV2 = {
      ...readyFood(),
      familyCode: 'accessory',
      values: [
        known('accessory.type', {
          type: 'single',
          value: firstOption('accessory.type'),
        }),
        known('measure.fit.neck', {
          type: 'range',
          min: 20,
          max: 30,
          unit: 'cm',
        }),
      ],
      facts: [
        {
          variantId: null,
          presentation: 'Collar mediano',
          declarations: [
            declaration('fitDeterminesChoice', false),
            declaration('relevantFitCodes', ['measure.fit.neck']),
            declaration('capacityDeterminesChoice', false),
            declaration('relevantCapacityCodes', []),
            declaration('electricalApplies', false),
            declaration('relevantEquipmentCodes', []),
          ],
          careReview: null,
        },
      ],
    };
    expect(expectAgreement(input(d))).toEqual(
      expect.arrayContaining([item('FACTS_CONFLICT', null, null, 'variant')]),
    );
  });

  describe('accessory per-type defaults (S7)', () => {
    const withoutDefaulted = [
      declaration('fitDeterminesChoice', false),
      declaration('relevantFitCodes', []),
    ];

    it.each(['collar', 'harness', 'leash'])(
      '%s: unknown capacity and electrical declarations do not block',
      (type) => {
        expect(
          expectAgreement(input(accessory(type, withoutDefaulted))),
        ).toEqual([]);
      },
    );

    it('a known «No» electrical declaration still rejects electrical values', () => {
      const power = known('measure.equipment.power', {
        type: 'number',
        value: 5,
        unit: 'W',
      });
      const d = accessory('collar', withoutDefaulted);
      d.values.push(power);
      expect(expectAgreement(input(d))).toEqual([]);
      d.facts[0].declarations.push(
        declaration('electricalApplies', false),
        declaration('relevantEquipmentCodes', []),
      );
      expect(expectAgreement(input(d))).toEqual([
        item('NOT_APPLICABLE_VALUE', 'measure.equipment.power'),
      ]);
    });

    it('a known capacity declaration wins and requires its value', () => {
      const d = accessory('collar', [
        ...withoutDefaulted,
        declaration('capacityDeterminesChoice', true),
        declaration('relevantCapacityCodes', ['measure.capacity.container']),
      ]);
      expect(expectAgreement(input(d))).toEqual([
        item('REQUIRED_MISSING', 'measure.capacity.container'),
      ]);
    });

    it('another accessory type keeps both declarations unresolved', () => {
      expect(
        expectAgreement(input(accessory('bowl', withoutDefaulted))),
      ).toEqual([item('UNRESOLVED', 'measure.capacity.container')]);
    });
  });

  it('CARE_REVIEW_INCOMPLETE: missing, unknown and unready reviews', () => {
    for (const review of [null, { state: 'unknown' } as const]) {
      expect(expectAgreement(input(readyCare(review)))).toEqual([
        item('CARE_REVIEW_INCOMPLETE', null, null, 'care', 'REVIEW_MISSING'),
      ]);
    }
    const open = readyReview();
    open.requirements[0].disposition = 'unresolved';
    open.warnings[0].disclosure = 'public_required';
    expect(expectAgreement(input(readyCare(open)))).toEqual([
      expect.objectContaining({ scope: 'care', detail: 'REQUIREMENT_OPEN' }),
      expect.objectContaining({ scope: 'care', detail: 'WARNING_PUBLIC' }),
    ]);
  });

  it('CARE_REVIEW_INCOMPLETE: each offered subject needs its own review row', () => {
    const d = readyCare();
    d.facts[0].variantId = 'a';
    d.values = d.values.map((v) => ({ ...v, variantId: 'a' }));
    const problems = expectAgreement(
      input(d, {
        references: { variantIds: ['a', 'b'], assetIds: [] },
        offeredSubjects: ['a', 'b'],
      }),
    );
    expect(problems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ scope: 'care', variantId: 'b' }),
      ]),
    );
    expect(
      problems.some((p) => p.scope === 'care' && p.variantId === 'a'),
    ).toBe(false);
  });

  it('ARCHIVED_OPTION: an archived option that the published version did not have', () => {
    const v = vocabulary();
    const format = v.definitions.find((d) => d.code === 'food.format');
    if (format?.type !== 'single') throw new Error('fixture');
    format.options.find((o) => o.code === 'food.format.kibble')!.archived =
      true;
    expect(expectAgreement(input(readyFood(), { vocabulary: v }))).toEqual([
      item('ARCHIVED_OPTION', 'food.format'),
    ]);
    expect(
      expectAgreement(
        input(readyFood(), { vocabulary: v, publishedDocument: readyFood() }),
      ),
    ).toEqual([]);
  });

  it('MEDIA_NOT_ALLOWED: media cannot be published yet', () => {
    const d = readyFood();
    d.mediaRefs = ['asset'];
    expect(expectAgreement(input(d))).toEqual([item('MEDIA_NOT_ALLOWED')]);
  });

  it('DRAFT_INVALID: a saved draft that no longer matches the product', () => {
    const d = readyFood('gone');
    const problems = expectAgreement(
      input(d, {
        references: { variantIds: ['a'], assetIds: [] },
        offeredSubjects: ['a'],
      }),
    );
    expect(problems).toEqual([item('DRAFT_INVALID')]);
  });

  it('does not change its inputs', () => {
    const value = input(readyFood());
    const before = structuredClone(value);
    evaluate(value);
    expect(value).toEqual(before);
  });

  it('propagates unexpected dependency errors', () => {
    const value = input(readyFood());
    value.vocabulary = { ...value.vocabulary, families: [] };
    expect(() => evaluate(value)).not.toThrow();
    expect(evaluate(value)).toEqual([item('DRAFT_INVALID')]);
  });
});

function firstOption(code: string): string {
  const d = vocabulary().definitions.find((x) => x.code === code);
  if (d?.type !== 'single' && d?.type !== 'multi') throw new Error('fixture');
  return d.options[0].code;
}
function accessory(
  type: string,
  declarations: DeclarationShapeV2[],
): DocumentShapeV2 {
  return {
    ...readyFood(),
    familyCode: 'accessory',
    values: [
      known('accessory.type', {
        type: 'single',
        value: `accessory.type.${type}`,
      }),
    ],
    facts: [
      {
        variantId: null,
        presentation: 'Pieza',
        declarations,
        careReview: null,
      },
    ],
  };
}
function toy(toyTypes: string[] | null): DocumentShapeV2 {
  return {
    ...readyFood(),
    familyCode: 'toy',
    values: [
      known('animal.target', { type: 'multi', value: ['ani.dom.dog'] }),
      known('toy.type', { type: 'multi', value: ['toy.type.ball'] }),
    ],
    facts: [
      {
        variantId: null,
        presentation: 'Pelota',
        declarations:
          toyTypes === null
            ? []
            : [declaration('relevantDimensionCodes', { codes: [], toyTypes })],
        careReview: null,
      },
    ],
  };
}
