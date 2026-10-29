import {
  EditorialVocabularyHeaderError,
  parseEditorialVocabularyHeaders,
} from './editorial-vocabulary-headers';

const versionHeader = 'Editorial-Contract-Version';
const prohibitedHeaders = [
  'Editorial-Vocabulary-Revision',
  'Editorial-Adoption',
  'Editorial-Care-Confirmation',
  'Idempotency-Key',
];

function accepts(headers: string[], version: 1 | 2) {
  const before = [...headers];
  Object.freeze(headers);
  expect(parseEditorialVocabularyHeaders(headers)).toBe(version);
  expect(headers).toEqual(before);
}

function rejects(headers: string[], statusCode: 400 | 406) {
  const before = [...headers];
  Object.freeze(headers);
  let result: 1 | 2 | undefined;
  let caught: unknown;
  try {
    result = parseEditorialVocabularyHeaders(headers);
  } catch (error) {
    caught = error;
  }
  expect(result).toBeUndefined();
  expect(caught).toBeInstanceOf(EditorialVocabularyHeaderError);
  expect(caught).toBeInstanceOf(Error);
  const code =
    statusCode === 406 ? 'UNSUPPORTED_EDITORIAL_CONTRACT' : 'MALFORMED';
  expect(caught).toMatchObject({
    code,
    message: code,
    statusCode,
    normalizedVersion: statusCode === 406 ? undefined : 2,
  });
  expect(Object.hasOwn(caught as object, 'normalizedVersion')).toBe(true);
  expect(headers).toEqual(before);
}

describe('parseEditorialVocabularyHeaders (dormant vocabulary GET admission)', () => {
  it('defaults an absent version to V1', () => accepts([], 1));
  it.each([1, 2] as const)('accepts exact version %s', (version) => {
    accepts([versionHeader, String(version)], version);
  });
  it.each([versionHeader.toLowerCase(), versionHeader.toUpperCase()])(
    'matches version name case-insensitively: %s',
    (name) => accepts([name, '2'], 2),
  );
  it.each([
    ['identical', versionHeader, '2'],
    ['conflicting', versionHeader, '1'],
    ['case variant', versionHeader.toLowerCase(), '2'],
  ])('rejects duplicate versions: %s', (_label, name, value) => {
    rejects([versionHeader, '2', name, value], 406);
  });
  it('rejects duplicate V1 even when identical', () => {
    rejects([versionHeader, '1', versionHeader, '1'], 406);
  });
  it.each([
    '1,2',
    '2, 2',
    '',
    ' ',
    ' 2',
    '2 ',
    '\t2',
    '+2',
    '02',
    '2.0',
    '0',
    '3',
    'future',
  ])(
    'rejects exact unsupported version value %j without normalization',
    (value) => {
      rejects([versionHeader, value], 406);
    },
  );

  describe.each(prohibitedHeaders)(
    'V2 prohibits any occurrence of %s',
    (name) => {
      it.each([name, name.toLowerCase(), name.toUpperCase()])(
        'matches prohibited name %s case-insensitively',
        (headerName) => rejects([versionHeader, '2', headerName, 'token'], 400),
      );
      it.each(['', ' ', 'a,b'])('rejects prohibited value %j', (value) => {
        rejects([name, value, versionHeader, '2'], 400);
      });
      it('rejects duplicate occurrences including empty/case-variant values', () => {
        rejects([versionHeader, '2', name, '', name.toLowerCase(), 'a,b'], 400);
      });
      it.each(['absent', 'explicit 1'])(
        'V1 %s ignores malformed duplicates',
        (mode) => {
          const headers = [name, '', name.toUpperCase(), ' , malformed '];
          if (mode === 'explicit 1') headers.push(versionHeader, '1');
          accepts(headers, 1);
        },
      );
      it.each(['first', 'last'])(
        'invalid version takes precedence when %s',
        (order) => {
          const invalid = [versionHeader, '02'];
          const forbidden = [name, ''];
          rejects(
            order === 'first'
              ? [...invalid, ...forbidden]
              : [...forbidden, ...invalid],
            406,
          );
        },
      );
    },
  );

  it('checks duplicate version before prohibited headers regardless of order', () => {
    const duplicate = [versionHeader, '2', versionHeader.toUpperCase(), '2'];
    rejects(['Idempotency-Key', '', ...duplicate], 406);
    rejects([...duplicate, 'Idempotency-Key', ''], 406);
  });
  it.each([1, 2] as const)(
    'ignores unrelated headers in V%s without HTTP syntax validation',
    (version) => {
      accepts(
        [
          versionHeader,
          String(version),
          'X-Unrelated',
          'a,b',
          'X-Unrelated',
          '',
          'Editorial-Contract-Version ',
          'bad',
          'not a header name',
          '\n',
        ],
        version,
      );
    },
  );
  it.each([
    ['not an array', null],
    ['odd pair count', [versionHeader]],
    ['non-string value', [versionHeader, 2]],
    ['non-string name', [2, '2']],
    ['sparse pair', new Array<string>(2)],
  ])('uses TypeError for internal programmer input: %s', (_label, input) => {
    expect(() =>
      parseEditorialVocabularyHeaders(input as readonly string[]),
    ).toThrow(TypeError);
    expect(() =>
      parseEditorialVocabularyHeaders(input as readonly string[]),
    ).not.toThrow(EditorialVocabularyHeaderError);
  });
});
