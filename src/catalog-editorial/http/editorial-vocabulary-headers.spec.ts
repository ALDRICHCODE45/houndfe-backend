import {
  EditorialVocabularyHeaderError,
  parseEditorialVocabularyHeaders,
} from './editorial-vocabulary-headers';

const versionHeader = 'Editorial-Contract-Version';
const prohibitedHeaders = [
  versionHeader,
  'Editorial-Vocabulary-Revision',
  'Editorial-Adoption',
  'Editorial-Care-Confirmation',
  'Idempotency-Key',
];

function accepts(headers: string[]) {
  const before = [...headers];
  Object.freeze(headers);
  expect(parseEditorialVocabularyHeaders(headers)).toBeUndefined();
  expect(headers).toEqual(before);
}

function rejects(headers: string[]) {
  const before = [...headers];
  Object.freeze(headers);
  let result: unknown;
  let caught: unknown;
  try {
    result = parseEditorialVocabularyHeaders(headers);
  } catch (error) {
    caught = error;
  }
  expect(result).toBeUndefined();
  expect(caught).toBeInstanceOf(EditorialVocabularyHeaderError);
  expect(caught).toBeInstanceOf(Error);
  expect(caught).toMatchObject({
    code: 'MALFORMED',
    message: 'MALFORMED',
    statusCode: 400,
  });
  expect(headers).toEqual(before);
}

describe('parseEditorialVocabularyHeaders (dormant vocabulary GET admission)', () => {
  it('accepts headerless requests without negotiating', () => accepts([]));
  describe.each(prohibitedHeaders)('prohibits any occurrence of %s', (name) => {
    it.each([name, name.toLowerCase(), name.toUpperCase()])(
      'matches name %s case-insensitively',
      (headerName) => rejects([headerName, 'token']),
    );
    it.each(['1', '2', '02', 'future', '', ' ', 'a,b'])(
      'rejects value %j without normalization',
      (value) => rejects([name, value]),
    );
    it('rejects duplicate occurrences including empty/case-variant values', () => {
      rejects([name, '', name.toLowerCase(), 'a,b']);
    });
  });
  it('ignores unrelated framework-parsed headers without HTTP syntax validation', () => {
    accepts([
      'X-Unrelated',
      'a,b',
      'X-Unrelated',
      '',
      'Editorial-Contract-Version ',
      'bad',
      'not a header name',
      '\n',
    ]);
  });
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
