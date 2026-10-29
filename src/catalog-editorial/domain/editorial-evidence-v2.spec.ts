import {
  EvidenceV2,
  isFreshEvidenceV2,
  parseEvidenceShapeV2,
} from './editorial-evidence-v2';

const evidence = (): EvidenceV2 => ({
  sourceRef: 'manufacturer:manual-42',
  verifiedOn: '2024-02-29',
});
const message = 'Expected an evidence shape V2';

function rejects(input: unknown): void {
  expect(() => parseEvidenceShapeV2(input)).toThrow(new TypeError(message));
}

describe('parseEvidenceShapeV2', () => {
  it.each(['plain', 'null prototype', 'frozen'])(
    '%s data is detached',
    (kind) => {
      const input: EvidenceV2 = evidence();
      if (kind === 'null prototype') Object.setPrototypeOf(input, null);
      if (kind === 'frozen') Object.freeze(input);
      const result = parseEvidenceShapeV2(input);
      expect(result).toStrictEqual(evidence());
      expect(Object.getPrototypeOf(result)).toBe(Object.prototype);
      expect(result).not.toBe(input);
      result.sourceRef = 'changed';
      expect(input.sourceRef).toBe(evidence().sourceRef);
    },
  );

  it.each([null, undefined, true, 1, 'text', Symbol('x'), [], () => 1])(
    'rejects non-record %p',
    rejects,
  );

  it.each([
    {},
    { sourceRef: 's' },
    { verifiedOn: 'd' },
    { ...evidence(), extra: null },
    { ...evidence(), sourceRef: null },
    { ...evidence(), verifiedOn: 20240229 },
    { ...evidence(), sourceRef: new String('s') },
  ])('rejects missing/extra/non-string fields %p', rejects);

  it('rejects hidden, symbol and exotic properties without mutation', () => {
    const inputs = [
      Object.defineProperty(evidence(), 'sourceRef', { enumerable: false }),
      Object.defineProperty(evidence(), 'extra', { value: 1 }),
      { ...evidence(), [Symbol('extra')]: 1 },
      Object.setPrototypeOf(evidence(), { inherited: true }) as unknown,
      Object.create(evidence()) as unknown,
    ];
    for (const input of inputs) {
      const before = Object.getOwnPropertyDescriptors(input);
      rejects(input);
      expect(Object.getOwnPropertyDescriptors(input)).toEqual(before);
    }
  });

  it.each(['sourceRef', 'verifiedOn', 'extra'])(
    'never invokes %s getters',
    (key) => {
      const getter = jest.fn(() => 'value');
      const input = Object.defineProperty(evidence(), key, {
        enumerable: true,
        get: getter,
      });
      rejects(input);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it('rejects setter-only descriptors', () => {
    const setter = jest.fn();
    rejects(Object.defineProperty(evidence(), 'sourceRef', { set: setter }));
    expect(setter).not.toHaveBeenCalled();
  });

  it.each(['getPrototypeOf', 'ownKeys', 'getOwnPropertyDescriptor'])(
    'preserves unexpected %s reflection failures by identity',
    (trap) => {
      for (const sentinel of [
        new Error('reflection'),
        new TypeError(message),
        42,
      ]) {
        const input = new Proxy(evidence(), {
          [trap]: () => {
            // eslint-disable-next-line @typescript-eslint/only-throw-error -- prove non-Error identity propagation
            throw sentinel;
          },
        });
        let caught: unknown;
        try {
          parseEvidenceShapeV2(input);
        } catch (error) {
          caught = error;
        }
        expect(caught).toBe(sentinel);
      }
    },
  );
});

describe('isFreshEvidenceV2', () => {
  function check(patch: Partial<EvidenceV2>, expected: boolean): void {
    const input = Object.freeze({ ...evidence(), ...patch });
    const before = { ...input };
    // Every fresh failure here remains acceptable to the primitive shape layer.
    const parsed = parseEvidenceShapeV2(input);
    expect(parsed).toStrictEqual(before);
    expect(isFreshEvidenceV2(parsed)).toBe(expected);
    expect(parsed).toStrictEqual(before);
    expect(input).toStrictEqual(before);
  }

  it.each([
    ['', false],
    ['a', true],
    ['a'.repeat(1000), true],
    ['a'.repeat(1001), false],
    ['😀'.repeat(1000), true],
    ['😀'.repeat(1001), false],
    [' \t\n\u00a0\u1680\u2000\u2028\u2029\u202f\u205f\u3000\ufeff', false],
    ['\u00a0\u1680\u2000\u2028\u2029\u202f\u205f\u3000\ufeff', false],
    ['  source  ', true],
    ['\ud800', false],
    ['\udfff', false],
    ['a\ud800b', false],
    ['a\udfffb', false],
    ['\ud83d\ude00', true],
    ['\u0085', true],
    ['\u009f', true],
  ] as const)('source case %#', (sourceRef, expected) => {
    check({ sourceRef }, expected);
  });

  it('rejects every C0 control and DEL, not just blank controls', () => {
    for (const code of [...Array.from({ length: 32 }, (_, i) => i), 127]) {
      check({ sourceRef: `a${String.fromCharCode(code)}b` }, false);
    }
  });

  it.each([
    ['0001-01-01', true],
    ['9999-12-31', true],
    ['0096-02-29', true],
    ['0099-02-29', false],
    ['0100-02-29', false],
    ['2000-02-29', true],
    ['2024-02-29', true],
    ['1900-02-29', false],
    ['2100-02-29', false],
    ['2023-02-29', false],
    ['2024-02-30', false],
    ['2024-04-30', true],
    ['2024-04-31', false],
    ['2024-01-31', true],
    ['2024-06-31', false],
    ['2024-09-31', false],
    ['2024-11-31', false],
    ['2024-00-01', false],
    ['2024-13-01', false],
    ['2024-01-00', false],
    ['2024-01-32', false],
    ['0000-01-01', false],
    ['', false],
    ['20240229', false],
    ['024-02-29', false],
    ['02024-02-29', false],
    ['2024-2-29', false],
    ['2024-02-9', false],
    ['٢٠٢٤-٠٢-٢٩', false],
    ['2024-02-29\n', false],
    ['2024-02-29T00:00:00Z', false],
    ['T2024-02-29', false],
    [' 2024-02-29', false],
  ] as const)('date %s', (verifiedOn, expected) => {
    check({ verifiedOn }, expected);
  });
});
