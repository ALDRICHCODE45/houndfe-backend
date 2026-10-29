import * as composition from '../application/editorial-vocabulary-read';
import { EditorialVocabularyRepresentationError } from '../domain/editorial-vocabulary-representation-error';
import { hashEditorialJson } from '../domain/editorial-canonical-json';
import { EditorialVocabularyHeaderError } from './editorial-vocabulary-headers';
import { createEditorialVocabularyHttpResponse as respond } from './editorial-vocabulary-response';

const version2 = ['Editorial-Contract-Version', '2'];
const fixture = () => ({
  metadata: { id: 'global', semanticsVersion: 'editorial-production-1' },
  families: [
    {
      id: 'f',
      code: 'custom.f',
      label: ' Family ñ ',
      minimumContractVersion: 1,
      bindings: [
        {
          familyId: 'f',
          definitionId: 'd',
          definitionCode: 'custom.d',
          owner: 'sellable',
          sortOrder: -2,
          exposure: 'DETAIL',
          searchable: false,
          publicationCheck: 'when_asserted',
          policy: { route: 'pending' },
        },
      ],
    },
  ],
  definitions: [
    {
      id: 'd',
      code: 'custom.d',
      label: ' Label ñ ',
      type: 'text',
      numericPolicy: null,
      units: [],
      options: [],
      groups: [],
      aliases: [],
    },
  ],
});
const legacy = {
  families: [
    {
      id: 'f',
      code: 'custom.f',
      label: ' Family ñ ',
      bindings: [
        {
          definitionId: 'd',
          definitionCode: 'custom.d',
          owner: 'sellable',
          sortOrder: -2,
        },
      ],
    },
  ],
  definitions: [
    { id: 'd', code: 'custom.d', label: ' Label ñ ', type: 'text' },
  ],
};
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
function headers(version?: 1 | 2) {
  return {
    'Cache-Control': 'no-store',
    ...(version === undefined
      ? {}
      : { 'Editorial-Contract-Version': String(version) }),
  };
}
function failure(statusCode: number, error: string, version?: 1 | 2) {
  return { statusCode, headers: headers(version), body: { statusCode, error } };
}
afterEach(() => jest.restoreAllMocks());

describe('dormant editorial vocabulary response descriptions', () => {
  it.each([1, 2] as const)(
    'composes real custom V%s without mutation or DTO reconstruction',
    async (version) => {
      const raw = fixture();
      const rawHeaders = ['EDITORIAL-CONTRACT-VERSION', String(version)];
      const before = JSON.stringify({ raw, rawHeaders });
      freeze(raw);
      freeze(rawHeaders);
      const source = { read: jest.fn().mockResolvedValue(raw) };
      const spy = jest.spyOn(composition, 'readEditorialVocabulary');
      const response = await respond(source, rawHeaders);
      const body: unknown = await spy.mock.results[0].value;
      const vocabulary = {
        semanticsVersion: 'editorial-production-1',
        families: raw.families.map(({ id, code, label, bindings }) => ({
          id,
          code,
          label,
          bindings: bindings.map(({ familyId, ...binding }) => {
            void familyId;
            return binding;
          }),
        })),
        definitions: legacy.definitions,
      };
      const revision = `ev2-sha256-${hashEditorialJson({ contractVersion: 2, vocabulary })}`;
      const expectedBody =
        version === 1
          ? legacy
          : {
              contractVersion: 2,
              vocabularyRevision: `ev2-sha256-${hashEditorialJson({ contractVersion: 2, vocabulary })}`,
              vocabulary,
            };
      expect(response).toEqual({
        statusCode: 200,
        headers: {
          ...headers(version),
          ...(version === 2
            ? {
                'Editorial-Vocabulary-Revision': revision,
              }
            : {}),
        },
        body: expectedBody,
      });
      expect(response.body).toBe(body);
      expect(spy).toHaveBeenCalledWith(source, version);
      expect(source.read).toHaveBeenCalledTimes(1);
      expect(JSON.stringify({ raw, rawHeaders })).toBe(before);
    },
  );

  it.each([1, 2] as const)(
    'returns the exact empty V%s descriptor',
    async (version) => {
      const vocabulary = {
        semanticsVersion: 'editorial-production-1',
        families: [],
        definitions: [],
      };
      const revision = `ev2-sha256-${hashEditorialJson({ contractVersion: 2, vocabulary })}`;
      const body =
        version === 1
          ? { families: [], definitions: [] }
          : {
              contractVersion: 2,
              vocabularyRevision: `ev2-sha256-${hashEditorialJson({ contractVersion: 2, vocabulary })}`,
              vocabulary,
            };
      const source = {
        read: jest
          .fn()
          .mockResolvedValue({ ...fixture(), families: [], definitions: [] }),
      };
      expect(await respond(source, version === 1 ? [] : version2)).toEqual({
        statusCode: 200,
        headers: {
          ...headers(version),
          ...(version === 2
            ? { 'Editorial-Vocabulary-Revision': revision }
            : {}),
        },
        body,
      });
      expect(source.read).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [
      'duplicate',
      [...version2, ...version2],
      406,
      'UNSUPPORTED_EDITORIAL_CONTRACT',
      undefined,
    ],
    [
      'list',
      ['Editorial-Contract-Version', '1,2'],
      406,
      'UNSUPPORTED_EDITORIAL_CONTRACT',
      undefined,
    ],
    [
      'unsupported',
      ['Editorial-Contract-Version', '3'],
      406,
      'UNSUPPORTED_EDITORIAL_CONTRACT',
      undefined,
    ],
    [
      'prohibited',
      [...version2, 'Editorial-Vocabulary-Revision', ''],
      400,
      'MALFORMED',
      2,
    ],
    [
      'programmer shape',
      ['Editorial-Contract-Version'],
      500,
      'INTERNAL_ERROR',
      undefined,
    ],
  ] as const)(
    'rejects %s before reading with exact secret-free output',
    async (_name, raw, status, code, version) => {
      const source = { read: jest.fn().mockResolvedValue(fixture()) };
      freeze(raw);
      const before = JSON.stringify(raw);
      expect(await respond(source, raw)).toEqual(
        failure(status, code, version),
      );
      expect(source.read).not.toHaveBeenCalled();
      expect(JSON.stringify(raw)).toBe(before);
    },
  );

  it('ignores legacy extras without enabling V2', async () => {
    const source = { read: jest.fn().mockResolvedValue(fixture()) };
    expect(
      await respond(source, [
        'Editorial-Adoption',
        'secret',
        'Idempotency-Key',
        '',
        'Editorial-Vocabulary-Revision',
        'old',
        'Editorial-Care-Confirmation',
        'x',
      ]),
    ).toEqual({
      statusCode: 200,
      headers: headers(1),
      body: legacy,
    });
    expect(source.read).toHaveBeenCalledTimes(1);
  });

  it.each(['missing metadata', 'policy extra field'])(
    'maps real %s to S27 only for V2',
    async (kind) => {
      const raw = fixture();
      const input =
        kind === 'missing metadata' ? { ...raw, metadata: null } : raw;
      if (kind === 'policy extra field') {
        Object.assign(raw.families[0].bindings[0], {
          policy: {
            route: 'option_cases',
            extra: true,
            cases: [
              {
                code: 'case',
                when: [],
                applicability: 'applicable',
                required: false,
                allowNA: false,
                evidenceRequired: false,
                documentary: 'unresolved',
              },
            ],
          },
        });
      }
      const source = { read: jest.fn().mockResolvedValue(input) };
      expect(await respond(source, version2)).toEqual(
        failure(500, 'EDITORIAL_VOCABULARY_UNREPRESENTABLE', 2),
      );
      expect(source.read).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    new Error('database secret'),
    new Error('EDITORIAL_VOCABULARY_UNREPRESENTABLE'),
    new EditorialVocabularyRepresentationError('raw secret'),
    new TypeError('secret'),
    new RangeError('secret'),
    new Error('Unsupported Unicode runtime'),
    { code: 'EDITORIAL_VOCABULARY_UNREPRESENTABLE', cause: 'secret' },
    'secret',
    null,
    new EditorialVocabularyHeaderError('MALFORMED', 400, 2),
    new EditorialVocabularyHeaderError(
      'UNSUPPORTED_EDITORIAL_CONTRACT',
      406,
      undefined,
    ),
  ])('hides unexpected source failure %# after negotiation', async (error) => {
    const source = { read: jest.fn().mockRejectedValue(error) };
    expect(await respond(source, version2)).toEqual(
      failure(500, 'INTERNAL_ERROR', 2),
    );
    expect(source.read).toHaveBeenCalledTimes(1);
  });

  it.each([1, 2] as const)(
    'hides a source decoding malformed-shape TypeError in V%s',
    async (version) => {
      const source = {
        read: jest.fn(async () => {
          const malformed: unknown = await Promise.resolve(null);
          return (malformed as { snapshot: unknown }).snapshot;
        }),
      };
      expect(
        await respond(source, ['Editorial-Contract-Version', String(version)]),
      ).toEqual(failure(500, 'INTERNAL_ERROR', version));
      expect(source.read).toHaveBeenCalledTimes(1);
    },
  );

  it('does not let an injected typed V2 error opt V1 into S27', async () => {
    const source = {
      read: jest
        .fn()
        .mockRejectedValue(
          new composition.EditorialVocabularyUnrepresentableError(
            new Error('private cause'),
          ),
        ),
    };
    expect(await respond(source, [])).toEqual(
      failure(500, 'INTERNAL_ERROR', 1),
    );
    expect(source.read).toHaveBeenCalledTimes(1);
  });

  it('keeps version and revision state local across repeated calls', async () => {
    const source = { read: jest.fn().mockResolvedValue(fixture()) };
    await respond(source, version2);
    expect(
      await respond(source, ['Editorial-Contract-Version', 'secret']),
    ).toEqual(failure(406, 'UNSUPPORTED_EDITORIAL_CONTRACT'));
    source.read.mockRejectedValueOnce(new Error('secret'));
    expect(await respond(source, [])).toEqual(
      failure(500, 'INTERNAL_ERROR', 1),
    );
    expect(await respond(source, [])).toEqual({
      statusCode: 200,
      headers: headers(1),
      body: legacy,
    });
    expect(source.read).toHaveBeenCalledTimes(3);
  });
});
