import { decodeRecordedReceiptResultV2 as decode } from './editorial-recorded-receipt-result-v2';
import { decodeRecordedEditorialStateV2 } from './editorial-recorded-state-v2';
import type {
  EditorialWriteOperationV2,
  ReceiptRequestV2,
} from './editorial-write-request-v2';

const R = `ev2-sha256-${'a'.repeat(64)}`;
const otherR = `ev2-sha256-${'b'.repeat(64)}`;
const operations: EditorialWriteOperationV2[] = [
  'initialize',
  'save',
  'publish',
  'discard',
];
const request: ReceiptRequestV2 = {
  receiptVersion: 2,
  contractVersion: 2,
  vocabularyRevision: R,
  adoption: null,
  careConfirmation: 'review-v1',
  body: { expectedCycle: 3, expectedRevision: 7 },
};
function fixture() {
  return {
    receiptVersion: 2,
    status: 200,
    body: {
      contractVersion: 2,
      vocabularyRevision: R,
      state: {
        cycle: 3,
        draft: null,
        published: {
          revision: 11,
          document: {
            mode: 'unsupported',
            document: { schemaVersion: 99, audit: ['\ud800', -0] },
          },
        },
        warnings: [],
      },
    },
    headers: {
      'Editorial-Contract-Version': '2',
      'Editorial-Vocabulary-Revision': R,
    },
    careAttestation: {
      actorId: '',
      confirmedAt: '2020-02-29T01:02:03.004Z',
      tenantId: '\ud800',
      productId: ' ',
      cycle: 3,
      draftRevision: 7,
      publishedRevision: 11,
      vocabularyRevision: R,
      documentDigest: `ecd2-sha256-${'b'.repeat(64)}`,
      subjects: [
        { variantId: 'v', presentation: 'second' },
        { variantId: null, presentation: '' },
        { variantId: 'v', presentation: 'second' },
      ],
    },
  };
}
type Fixture = ReturnType<typeof fixture>;
function reject(value: unknown) {
  expect(() => decode('publish', request, value)).toThrow(
    new TypeError('Expected a recorded receipt result V2'),
  );
}
function containers(value: Fixture): object[] {
  return [
    value,
    value.headers,
    value.careAttestation,
    value.careAttestation.subjects[0],
  ];
}

describe('recorded receipt V2 (S2, contract §4/facts §3)', () => {
  it.each(operations)(
    'maps %s status and requires null without confirmation',
    (op) => {
      const value = {
        ...fixture(),
        status: op === 'initialize' ? 201 : 200,
        careAttestation: null,
      };
      const document = {
        schemaVersion: 2 as const,
        commercialTitle: null,
        description: null,
        mediaRefs: [],
        familyCode: null,
        values: [],
        facts: [],
      };
      const unconfirmed: ReceiptRequestV2 = {
        ...request,
        careConfirmation: null,
        body:
          op === 'initialize'
            ? { expectedCycle: 3 }
            : op === 'save'
              ? { expectedCycle: 3, expectedRevision: 7, document }
              : { expectedCycle: 3, expectedRevision: 7 },
      };
      expect(decode(op, unconfirmed, value)).toEqual(value);
      expect(() =>
        decode(op, unconfirmed, {
          ...value,
          status: value.status === 200 ? 201 : 200,
        }),
      ).toThrow(TypeError);
      expect(() =>
        decode(op, unconfirmed, {
          ...value,
          careAttestation: fixture().careAttestation,
        }),
      ).toThrow(TypeError);
    },
  );
  it('requires confirmed publish attestation and explicit operation', () => {
    reject({ ...fixture(), careAttestation: null });
    expect(() =>
      decode('other' as EditorialWriteOperationV2, request, fixture()),
    ).toThrow(TypeError);
  });
  it.each([0, 1, 2, 3])(
    'closes container %i with required data fields',
    (index) => {
      for (const key of Object.keys(containers(fixture())[index])) {
        for (const change of ['missing', 'primitive', 'hidden', 'accessor']) {
          const value = fixture();
          const target = containers(value)[index];
          const getter = jest.fn(() => {
            throw new Error('getter invoked');
          });
          if (change === 'missing') Reflect.deleteProperty(target, key);
          else
            Object.defineProperty(
              target,
              key,
              change === 'accessor'
                ? { get: getter }
                : { value: false, enumerable: change !== 'hidden' },
            );
          if (index === 0 && key === 'body' && change === 'primitive')
            expect(() => decode('publish', request, value)).toThrow(
              new TypeError('Expected a recorded editorial state V2'),
            );
          else reject(value);
          expect(getter).not.toHaveBeenCalled();
        }
      }
      for (const key of ['extra', Symbol('extra')]) {
        const value = fixture();
        Object.defineProperty(containers(value)[index], key, { value: 1 });
        reject(value);
      }
    },
  );
  it.each([null, [], new Date(), 1])('rejects nonrecord roots %p', reject);
  it('rejects nonplain nested containers and wrong version/header revisions', () => {
    for (const index of [0, 1, 2, 3]) {
      const value = fixture();
      Object.setPrototypeOf(containers(value)[index], { inherited: true });
      reject(value);
    }
    for (const key of Object.keys(fixture().headers)) {
      const value = fixture();
      Reflect.set(value.headers, key, key.includes('Contract') ? 2 : otherR);
      reject(value);
    }
    const wrongVersion = fixture();
    wrongVersion.headers['Editorial-Contract-Version'] = '1';
    reject(wrongVersion);
    const value = fixture();
    value.body.vocabularyRevision = otherR;
    reject(value);
    expect(() =>
      decode('publish', { ...request, vocabularyRevision: otherR }, fixture()),
    ).toThrow(TypeError);
  });
  it('checks request and recorded counters, and requires Published', () => {
    for (const key of [
      'cycle',
      'draftRevision',
      'publishedRevision',
      'vocabularyRevision',
    ]) {
      const value = fixture();
      Reflect.set(
        value.careAttestation,
        key,
        key === 'vocabularyRevision' ? otherR : 2,
      );
      reject(value);
    }
    const value = fixture();
    value.body.state.cycle = 4;
    reject(value);
    const absent = fixture();
    Reflect.set(absent.body.state, 'published', null);
    reject(absent);
  });
  it.each([0, -1, 1.5, 2147483648, NaN, Infinity, '7'])(
    'rejects counter %p',
    (counter) => {
      for (const key of ['cycle', 'draftRevision', 'publishedRevision']) {
        const value = fixture();
        Reflect.set(value.careAttestation, key, counter);
        reject(value);
      }
    },
  );
  it('accepts int32 max without cross-counter arithmetic', () => {
    const value = fixture();
    value.careAttestation.draftRevision = 2147483647;
    expect(
      decode(
        'publish',
        {
          ...request,
          body: { expectedCycle: 3, expectedRevision: 2147483647 },
        },
        value,
      ),
    ).toEqual(value);
  });
  it.each([
    '0000-01-01T00:00:00.000Z',
    '+010000-01-01T00:00:00.000Z',
    '-000001-01-01T00:00:00.000Z',
  ])('accepts canonical timestamp %s without clock checks', (time) => {
    const value = fixture();
    value.careAttestation.confirmedAt = time;
    expect(decode('publish', request, value)).toEqual(value);
  });
  it.each([
    '2021-02-29T00:00:00.000Z',
    '2020-01-01T24:00:00.000Z',
    '2020-01-01T00:00:00Z',
    '2020-01-01T00:00:00.000+00:00',
    'invalid',
  ])('rejects noncanonical timestamp %s', (time) => {
    const value = fixture();
    value.careAttestation.confirmedAt = time;
    reject(value);
  });
  it.each(['b'.repeat(64) + '\n', 'B'.repeat(64), '', 'b'.repeat(65)])(
    'rejects malformed digest hex %p',
    (hex) => {
      const value = fixture();
      value.careAttestation.documentDigest = `ecd2-sha256-${hex}`;
      reject(value);
    },
  );
  it('rejects sparse/decorated/accessor subject arrays without getters', () => {
    for (const kind of ['hole', 'symbol', 'hidden', 'getter', 'primitive']) {
      const value = fixture();
      const subjects = value.careAttestation.subjects;
      const getter = jest.fn();
      if (kind === 'hole') Reflect.deleteProperty(subjects, '0');
      if (kind === 'symbol') Reflect.set(subjects, Symbol('extra'), 1);
      if (kind === 'hidden')
        Object.defineProperty(subjects, 'extra', { value: 1 });
      if (kind === 'getter')
        Object.defineProperty(subjects, '0', { get: getter });
      if (kind === 'primitive')
        Reflect.set(value.careAttestation, 'subjects', {});
      reject(value);
      expect(getter).not.toHaveBeenCalled();
    }
  });
  it('detaches frozen null-prototype history, full audit and ordered duplicate subjects', () => {
    const value = fixture();
    function freeze(input: object) {
      for (const child of Object.values(input))
        if (child && typeof child === 'object') freeze(child as object);
      if (!Array.isArray(input)) Object.setPrototypeOf(input, null);
      Object.freeze(input);
    }
    freeze(value);
    const result = decode('publish', request, value);
    expect(result).toEqual(value);
    expect(result).not.toBe(value);
    expect(result.headers).not.toBe(value.headers);
    expect(result.body.state.published?.document.document).not.toBe(
      value.body.state.published.document.document,
    );
    expect(result.careAttestation?.subjects[0]).not.toBe(
      value.careAttestation.subjects[0],
    );
    result.careAttestation?.subjects.pop();
    expect(value.careAttestation.subjects).toHaveLength(3);
    expect(result.body.state.warnings).toEqual([]);
    const empty = fixture();
    empty.careAttestation.subjects = [];
    expect(decode('publish', request, empty)).toEqual(empty);
  });
  it.each([new Error('reflection'), new TypeError('reflection'), 'sentinel'])(
    'propagates unexpected reflection identity %p',
    (sentinel) => {
      const value = fixture();
      const proxy = new Proxy(value, {
        ownKeys() {
          // Exercise propagation of arbitrary reflection failures, including non-Errors.
          // eslint-disable-next-line @typescript-eslint/only-throw-error
          throw sentinel;
        },
      });
      let caught: unknown;
      try {
        decode('publish', request, proxy);
      } catch (error) {
        caught = error;
      }
      expect(caught).toBe(sentinel);
    },
  );
  it('propagates the nested state deliberate error without reclassification', () => {
    const value = fixture();
    value.body.contractVersion = 1;
    let nested: unknown;
    try {
      decodeRecordedEditorialStateV2(value.body);
    } catch (error) {
      nested = error;
    }
    expect(() => decode('publish', request, value)).toThrow(
      nested as TypeError,
    );
  });
});
