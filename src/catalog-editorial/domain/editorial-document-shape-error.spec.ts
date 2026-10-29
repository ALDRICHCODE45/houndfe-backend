import { EditorialDocumentShapeError } from './editorial-document-shape-error';
import { parseDocumentShapeV2 } from './editorial-document-shape-v2';
import { parseValueShapeV2 } from './editorial-value-shape-v2';
import { parseKnownPayloadShapeV2 } from './editorial-known-payload-shape-v2';
import { parseEvidenceShapeV2 } from './editorial-evidence-v2';
import { parseSellableFactsShapeV2 } from './editorial-sellable-facts-shape-v2';
import { parseDeclarationShapeV2 } from './editorial-declaration-shape-v2';
import { parseCareCaptureShapeV2 } from './editorial-care-capture-shape-v2';
import {
  parseCareRequirementShapeV2,
  parseCareWarningShapeV2,
} from './editorial-care-entry-shape-v2';

const evidence = { sourceRef: '\ud800', verifiedOn: 'historical date' };
const payload = { type: 'range', min: 9, max: 1, unit: '' };
const value = {
  code: '',
  owner: 'product',
  variantId: 'historical variant',
  state: 'known',
  payload,
  evidence,
};
const declaration = {
  key: 'relevantDimensionCodes',
  state: 'known',
  value: { codes: ['', ''], toyTypes: ['unknown'] },
  evidence,
  basis: '',
};
const requirement = {
  key: '',
  description: '',
  disposition: 'conflicting',
  evidence: [evidence],
  basis: '',
};
const warning = {
  key: '',
  requirementKeys: ['missing', 'missing'],
  text: '',
  disclosure: 'public_required',
  evidence: [evidence],
  handlingBasis: '',
};
const care = {
  state: 'prepared',
  jurisdiction: '',
  intendedUse: '',
  determination: 'none_applicable',
  evidence: [evidence],
  basis: '',
  requirements: [requirement],
  warnings: [warning],
};
const facts = {
  variantId: null,
  presentation: '',
  declarations: [declaration],
  careReview: care,
};
const document = {
  schemaVersion: 2,
  commercialTitle: null,
  description: '',
  mediaRefs: ['', ''],
  familyCode: null,
  values: [value, value],
  facts: [facts],
};

type Contract = {
  label: string;
  parse: (input: unknown) => unknown;
  accepted: object;
  message: string;
  inDocument: (input: unknown) => unknown;
};
const withValue = (input: unknown) => ({ ...document, values: [input] });
const withFacts = (input: unknown) => ({ ...document, facts: [input] });
const withCare = (input: unknown) => withFacts({ ...facts, careReview: input });
const contracts: Contract[] = [
  {
    label: 'document',
    parse: parseDocumentShapeV2,
    accepted: document,
    message: 'Expected a document shape V2',
    inDocument: (input) => input,
  },
  {
    label: 'value',
    parse: parseValueShapeV2,
    accepted: value,
    message: 'Expected a value shape V2',
    inDocument: withValue,
  },
  {
    label: 'payload',
    parse: parseKnownPayloadShapeV2,
    accepted: payload,
    message: 'Expected a known payload shape V2',
    inDocument: (input) => withValue({ ...value, payload: input }),
  },
  {
    label: 'evidence',
    parse: parseEvidenceShapeV2,
    accepted: evidence,
    message: 'Expected an evidence shape V2',
    inDocument: (input) => withValue({ ...value, evidence: input }),
  },
  {
    label: 'facts',
    parse: parseSellableFactsShapeV2,
    accepted: facts,
    message: 'Expected a sellable facts shape V2',
    inDocument: withFacts,
  },
  {
    label: 'declaration',
    parse: parseDeclarationShapeV2,
    accepted: declaration,
    message: 'Expected a declaration shape V2',
    inDocument: (input) => withFacts({ ...facts, declarations: [input] }),
  },
  {
    label: 'care capture',
    parse: parseCareCaptureShapeV2,
    accepted: care,
    message: 'Expected a care capture shape V2',
    inDocument: withCare,
  },
  {
    label: 'care requirement',
    parse: parseCareRequirementShapeV2,
    accepted: requirement,
    message: 'Expected a care entry shape V2',
    inDocument: (input) => withCare({ ...care, requirements: [input] }),
  },
  {
    label: 'care warning',
    parse: parseCareWarningShapeV2,
    accepted: warning,
    message: 'Expected a care entry shape V2',
    inDocument: (input) => withCare({ ...care, warnings: [input] }),
  },
];

function thrown(action: () => unknown): unknown {
  try {
    action();
  } catch (error) {
    return error;
  }
  throw new Error('Expected parser rejection');
}

function expectRejection(error: unknown, message: string): void {
  expect(error).toBeInstanceOf(TypeError);
  expect(error).toBeInstanceOf(Error);
  expect(error).toHaveProperty('name', 'TypeError');
  expect(error).toHaveProperty('message', message);
  expect(error).toBeInstanceOf(EditorialDocumentShapeError);
}

function expectDetached(actual: unknown, expected: unknown): void {
  expect(actual).toStrictEqual(expected);
  if (expected !== null && typeof expected === 'object') {
    expect(actual).not.toBe(expected);
    for (const key of Object.keys(expected)) {
      expectDetached(
        (actual as Record<string, unknown>)[key],
        (expected as Record<string, unknown>)[key],
      );
    }
  }
}

const traps = [
  'getPrototypeOf',
  'ownKeys',
  'getOwnPropertyDescriptor',
] as const;

describe.each(contracts)('$label public rejection contract', (contract) => {
  it('tags intentional rejection without changing TypeError name or message', () => {
    expectRejection(
      thrown(() => contract.parse({})),
      contract.message,
    );
  });

  it('preserves the originating rejection through document composition', () => {
    expectRejection(
      thrown(() => parseDocumentShapeV2(contract.inDocument({}))),
      contract.message,
    );
  });

  it('preserves representative historical output and detaches every container', () => {
    expectDetached(contract.parse(contract.accepted), contract.accepted);
    expectDetached(
      parseDocumentShapeV2(contract.inDocument(contract.accepted)),
      contract.inDocument(contract.accepted),
    );
  });

  describe.each(traps)('%s reflection failures', (trap) => {
    it.each(['TypeError', 'Error', 'sentinel'])(
      'preserves %s identity',
      (kind) => {
        const unexpected =
          kind === 'TypeError'
            ? new TypeError(contract.message)
            : kind === 'Error'
              ? new Error(contract.message)
              : Symbol('unexpected reflection failure');
        const input = new Proxy(contract.accepted, {
          [trap]: () => {
            // Exercise propagation of non-Error values thrown by reflection.
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw unexpected;
          },
        });
        expect(thrown(() => contract.parse(input))).toBe(unexpected);
        expect(
          thrown(() => parseDocumentShapeV2(contract.inDocument(input))),
        ).toBe(unexpected);
        expect(unexpected).not.toBeInstanceOf(EditorialDocumentShapeError);
      },
    );
  });

  it('does not tag the engine TypeError from a revoked proxy', () => {
    const { proxy, revoke } = Proxy.revocable(contract.accepted, {});
    revoke();
    for (const action of [
      () => contract.parse(proxy),
      () => parseDocumentShapeV2(contract.inDocument(proxy)),
    ]) {
      const error = thrown(action);
      expect(error).toBeInstanceOf(TypeError);
      expect(error).not.toBeInstanceOf(EditorialDocumentShapeError);
    }
  });
});
