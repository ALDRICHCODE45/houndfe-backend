import * as composition from '../application/editorial-vocabulary-read';
import { EditorialVocabularyRepresentationError } from '../domain/editorial-vocabulary-representation-error';
import { hashEditorialJson } from '../domain/editorial-canonical-json';
import { EditorialVocabularyHeaderError } from './editorial-vocabulary-headers';
import { createEditorialVocabularyHttpResponse as respond } from './editorial-vocabulary-response';

const version2 = ['Editorial-Contract-Version', '2'];
const acceptedHeaders = [
  { rawHeaders: [] },
  { rawHeaders: ['X-Unrelated', 'a,b', 'X-Unrelated', ''] },
];
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
function headers() {
  return {
    'Cache-Control': 'no-store',
    'Editorial-Contract-Version': '2',
  };
}
function failure(statusCode: number, error: string) {
  return { statusCode, headers: headers(), body: { statusCode, error } };
}
afterEach(() => jest.restoreAllMocks());

describe('dormant editorial vocabulary response descriptions', () => {
  it.each(acceptedHeaders)(
    'composes canonical body without mutation or DTO reconstruction',
    async ({ rawHeaders }) => {
      const raw = fixture();
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
      const expectedBody = {
        contractVersion: 2,
        vocabularyRevision: revision,
        vocabulary,
      };
      expect(response).toEqual({
        statusCode: 200,
        headers: {
          ...headers(),
          'Editorial-Vocabulary-Revision': revision,
        },
        body: expectedBody,
      });
      expect(response.body).toBe(body);
      expect(spy).toHaveBeenCalledWith(source);
      expect(source.read).toHaveBeenCalledTimes(1);
      expect(JSON.stringify({ raw, rawHeaders })).toBe(before);
    },
  );

  describe('definition descriptions (display help outside the revision)', () => {
    const plainResponse = () =>
      respond({ read: jest.fn().mockResolvedValue(fixture()) }, []);
    const sourceWith = (descriptions: Map<string, string>) => {
      const snapshot = fixture();
      return {
        read: jest.fn().mockResolvedValue(snapshot),
        readWithDescriptions: jest
          .fn()
          .mockResolvedValue({ snapshot, descriptions }),
      };
    };

    it('attaches description to the matching definition and keeps the revision byte-identical', async () => {
      const plain = await plainResponse();
      const source = sourceWith(
        new Map([['custom.d', 'Ayuda para el usuario.']]),
      );
      const response = await respond(source, []);
      const body = response.body as {
        vocabularyRevision: string;
        vocabulary: { definitions: unknown[] };
      };
      expect(body.vocabulary.definitions).toEqual([
        { ...legacy.definitions[0], description: 'Ayuda para el usuario.' },
      ]);
      // Revision/digest unchanged by populating descriptions; header mirrors it.
      expect(body.vocabularyRevision).toBe(
        (plain.body as { vocabularyRevision: string }).vocabularyRevision,
      );
      expect(response.headers['Editorial-Vocabulary-Revision']).toBe(
        body.vocabularyRevision,
      );
      // Independent oracle: the digest covers the vocabulary WITHOUT descriptions.
      expect(body.vocabularyRevision).toBe(
        `ev2-sha256-${hashEditorialJson({
          contractVersion: 2,
          vocabulary: (plain.body as { vocabulary: unknown }).vocabulary,
        })}`,
      );
      expect(source.readWithDescriptions).toHaveBeenCalledTimes(1);
      expect(source.read).not.toHaveBeenCalled();
    });

    it('serves the plain body when no definition has a description', async () => {
      const response = await respond(sourceWith(new Map()), []);
      expect(response).toEqual(await plainResponse());
      expect(JSON.stringify(response.body)).not.toContain('description');
    });

    it('hides a failing description read behind INTERNAL_ERROR without a revision header', async () => {
      const source = {
        read: jest.fn(),
        readWithDescriptions: jest.fn().mockRejectedValue(new Error('secret')),
      };
      expect(await respond(source, [])).toEqual(failure(500, 'INTERNAL_ERROR'));
    });

    it('attaches production family sections after the revision, alongside descriptions', async () => {
      const production = () => {
        const raw = fixture();
        raw.families[0].code = 'food';
        raw.families[0].bindings[0].definitionCode = 'life.stage';
        raw.definitions[0].code = 'life.stage';
        return raw;
      };
      const plain = await respond(
        { read: jest.fn().mockResolvedValue(production()) },
        [],
      );
      const snapshot = production();
      const described = await respond(
        {
          read: jest.fn(),
          readWithDescriptions: jest.fn().mockResolvedValue({
            snapshot,
            descriptions: new Map([['life.stage', 'Texto.']]),
          }),
        },
        [],
      );
      for (const response of [plain, described]) {
        const body = response.body as {
          vocabularyRevision: string;
          vocabulary: {
            families: { sections?: unknown; bindings: unknown[] }[];
            definitions: unknown[];
          };
        };
        const [family] = body.vocabulary.families;
        expect(family.sections).toEqual([
          { code: 'para-quien', label: 'Para quién', sortOrder: 0 },
        ]);
        expect(family.bindings[0]).toMatchObject({
          definitionCode: 'life.stage',
          sortOrder: -2,
          sectionCode: 'para-quien',
          sectionSortOrder: 1,
        });
        // Independent oracle: the digest covers the vocabulary WITHOUT sections.
        const { sections, ...bare } = family as Record<string, unknown>;
        void sections;
        const bindings = family.bindings.map((binding) => {
          const { sectionCode, sectionSortOrder, ...rest } = binding as Record<
            string,
            unknown
          >;
          void sectionCode;
          void sectionSortOrder;
          return rest;
        });
        expect(body.vocabularyRevision).toBe(
          `ev2-sha256-${hashEditorialJson({
            contractVersion: 2,
            vocabulary: {
              ...body.vocabulary,
              families: [{ ...bare, bindings }],
              definitions: [{ ...legacy.definitions[0], code: 'life.stage' }],
            },
          })}`,
        );
        expect(response.headers['Editorial-Vocabulary-Revision']).toBe(
          body.vocabularyRevision,
        );
      }
      expect(
        (described.body as { vocabulary: { definitions: unknown[] } })
          .vocabulary.definitions[0],
      ).toMatchObject({ description: 'Texto.' });
    });

    it('rejects prohibited headers before any description read', async () => {
      const source = sourceWith(new Map([['custom.d', 'Texto.']]));
      expect(await respond(source, version2)).toEqual(
        failure(400, 'MALFORMED'),
      );
      expect(source.readWithDescriptions).not.toHaveBeenCalled();
    });
  });

  it.each(acceptedHeaders)(
    'returns the exact empty canonical descriptor',
    async ({ rawHeaders }) => {
      const vocabulary = {
        semanticsVersion: 'editorial-production-1',
        families: [],
        definitions: [],
      };
      const revision = `ev2-sha256-${hashEditorialJson({ contractVersion: 2, vocabulary })}`;
      const body = {
        contractVersion: 2,
        vocabularyRevision: revision,
        vocabulary,
      };
      const source = {
        read: jest
          .fn()
          .mockResolvedValue({ ...fixture(), families: [], definitions: [] }),
      };
      expect(await respond(source, rawHeaders)).toEqual({
        statusCode: 200,
        headers: {
          ...headers(),
          'Editorial-Vocabulary-Revision': revision,
        },
        body,
      });
      expect(source.read).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    ['version 1', ['Editorial-Contract-Version', '1'], 400, 'MALFORMED'],
    ['version 2', version2, 400, 'MALFORMED'],
    ['duplicate', [...version2, ...version2], 400, 'MALFORMED'],
    ['list', ['Editorial-Contract-Version', '1,2'], 400, 'MALFORMED'],
    ['malformed', ['Editorial-Contract-Version', '02'], 400, 'MALFORMED'],
    ['empty', ['Editorial-Contract-Version', ''], 400, 'MALFORMED'],
    ['programmer shape', ['Editorial-Contract-Version'], 500, 'INTERNAL_ERROR'],
    ['programmer array', null, 500, 'INTERNAL_ERROR'],
    ['programmer value', ['X', 2], 500, 'INTERNAL_ERROR'],
  ] as const)(
    'rejects %s before reading with exact secret-free output',
    async (_name, raw, status, code) => {
      const source = { read: jest.fn().mockResolvedValue(fixture()) };
      freeze(raw);
      const before = JSON.stringify(raw);
      expect(await respond(source, raw as readonly string[])).toEqual(
        failure(status, code),
      );
      expect(source.read).not.toHaveBeenCalled();
      expect(JSON.stringify(raw)).toBe(before);
    },
  );

  it.each([
    'Editorial-Adoption',
    'Idempotency-Key',
    'Editorial-Vocabulary-Revision',
    'Editorial-Care-Confirmation',
  ])('rejects formerly ignored %s before reading', async (name) => {
    const source = { read: jest.fn().mockResolvedValue(fixture()) };
    expect(await respond(source, [name, 'secret'])).toEqual(
      failure(400, 'MALFORMED'),
    );
    expect(source.read).not.toHaveBeenCalled();
  });

  it.each(['missing metadata', 'policy extra field'])(
    'maps real %s to S27',
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
      expect(await respond(source, [])).toEqual(
        failure(500, 'EDITORIAL_VOCABULARY_UNREPRESENTABLE'),
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
    new EditorialVocabularyHeaderError(),
  ])('hides unexpected source failure %#', async (error) => {
    const source = { read: jest.fn().mockRejectedValue(error) };
    expect(await respond(source, [])).toEqual(failure(500, 'INTERNAL_ERROR'));
    expect(source.read).toHaveBeenCalledTimes(1);
  });

  it.each(acceptedHeaders)(
    'hides a source decoding malformed-shape TypeError',
    async ({ rawHeaders }) => {
      const source = {
        read: jest.fn(async () => {
          const malformed: unknown = await Promise.resolve(null);
          return (malformed as { snapshot: unknown }).snapshot;
        }),
      };
      expect(await respond(source, rawHeaders)).toEqual(
        failure(500, 'INTERNAL_ERROR'),
      );
      expect(source.read).toHaveBeenCalledTimes(1);
    },
  );

  it('maps the typed application error without leaking its private cause', async () => {
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
      failure(500, 'EDITORIAL_VOCABULARY_UNREPRESENTABLE'),
    );
    expect(source.read).toHaveBeenCalledTimes(1);
  });

  it('keeps headers local across interleaved success and failure calls', async () => {
    let complete!: (value: unknown) => void;
    const source = {
      read: jest.fn(
        () =>
          new Promise((resolve) => {
            complete = resolve;
          }),
      ),
    };
    const pending = respond(source, []);
    const rejectedSource = { read: jest.fn().mockResolvedValue(fixture()) };
    const rejected = await respond(rejectedSource, version2);
    expect(rejected).toEqual(failure(400, 'MALFORMED'));
    const failed = await respond(
      { read: jest.fn().mockRejectedValue('secret') },
      [],
    );
    expect(failed).toEqual(failure(500, 'INTERNAL_ERROR'));
    complete(fixture());
    const success = await pending;
    expect(success.statusCode).toBe(200);
    expect(success.headers['Editorial-Vocabulary-Revision']).toBe(
      (success.body as { vocabularyRevision: string }).vocabularyRevision,
    );
    expect(success.headers).not.toBe(rejected.headers);
    expect(success.headers).not.toBe(failed.headers);
    success.headers['Editorial-Vocabulary-Revision'] = 'changed';
    expect(rejected).toEqual(failure(400, 'MALFORMED'));
    expect(failed).toEqual(failure(500, 'INTERNAL_ERROR'));
    expect(source.read).toHaveBeenCalledTimes(1);
    expect(rejectedSource.read).not.toHaveBeenCalled();
  });
});
