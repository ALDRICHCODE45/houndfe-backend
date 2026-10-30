import { hashEditorialJson } from '../domain/editorial-canonical-json';
import * as unicode from '../domain/editorial-alias-comparison-v1';
import * as historicalV2 from '../domain/editorial-vocabulary-historical-v2';
import { EditorialVocabularyRepresentationError } from '../domain/editorial-vocabulary-representation-error';
import { PrismaEditorialVocabularySnapshot } from '../infrastructure/prisma-editorial-vocabulary-snapshot';
import {
  EditorialVocabularyUnrepresentableError,
  readEditorialVocabulary as read,
} from './editorial-vocabulary-read';

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
      type: 'single',
      numericPolicy: null,
      units: [],
      groups: [],
      aliases: [],
      options: ['z', 'a'].map((code) => ({
        definitionId: 'd',
        definitionType: 'single',
        code,
        label: ` ${code} ñ `,
        sortOrder: 3,
        archivedAt: code === 'z' ? 'historical archive' : null,
      })),
    },
  ],
});
function freeze(value: unknown): void {
  if (value && typeof value === 'object') {
    Object.values(value).forEach(freeze);
    Object.freeze(value);
  }
}
function adapter(input: unknown) {
  const $queryRaw = jest.fn().mockResolvedValue([{ snapshot: input }]);
  return {
    source: new PrismaEditorialVocabularySnapshot({ $queryRaw }),
    $queryRaw,
  };
}
function projectors() {
  return {
    v2: jest.spyOn(historicalV2, 'materializeHistoricalVocabularyResponseV2'),
  };
}
const options = ['z', 'a'].map((code) => ({
  code,
  label: ` ${code} ñ `,
  sortOrder: 3,
  archived: code === 'z',
}));
const vocabulary = {
  semanticsVersion: 'editorial-production-1',
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
      type: 'single',
      options: [options[1], options[0]],
      groups: [],
      aliases: [],
    },
  ],
};

describe('dormant editorial vocabulary read', () => {
  afterEach(() => jest.restoreAllMocks());

  it.each([1, 2] as const)(
    'reads one raw Prisma snapshot with stored column %s into the exact canonical output',
    async (minimumContractVersion) => {
      const input = fixture();
      input.families[0].minimumContractVersion = minimumContractVersion;
      const before = structuredClone(input);
      freeze(input);
      const { source, $queryRaw } = adapter(input);
      const spies = projectors();
      const result = await read(source);
      expect($queryRaw).toHaveBeenCalledTimes(1);
      expect(spies.v2).toHaveBeenCalledTimes(1);
      expect(spies.v2.mock.calls[0][0]).toBe(input);
      expect(result).toBe(spies.v2.mock.results[0].value);
      expect(result).toEqual({
        contractVersion: 2,
        vocabularyRevision: `ev2-sha256-${hashEditorialJson({ contractVersion: 2, vocabulary })}`,
        vocabulary,
      });
      const detached = result.vocabulary;
      detached.definitions[0].label = 'changed';
      detached.families[0].bindings[0].sortOrder = 99;
      expect(input).toEqual(before);
    },
  );

  it.each(['policy extra field', 'unrepresentable metadata'])(
    'rejects the whole V2 response for %s without mutation',
    async (kind) => {
      const input = fixture();
      if (kind === 'policy extra field') {
        input.families[0].bindings[0].policy = {
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
        } as (typeof input.families)[0]['bindings'][0]['policy'];
      } else input.metadata.semanticsVersion = 'unsupported';
      const before = structuredClone(input);
      freeze(input);
      const { source, $queryRaw } = adapter(input);
      const spies = projectors();
      const error: unknown = await read(source).catch(
        (error: unknown) => error,
      );
      expect(error).toBeInstanceOf(EditorialVocabularyUnrepresentableError);
      const translated = error as EditorialVocabularyUnrepresentableError;
      expect(translated.message).toBe('EDITORIAL_VOCABULARY_UNREPRESENTABLE');
      expect(translated.cause).toBeInstanceOf(
        EditorialVocabularyRepresentationError,
      );
      expect(translated.cause).toBe(spies.v2.mock.results[0].value);
      expect(translated).not.toBe(translated.cause);
      expect($queryRaw).toHaveBeenCalledTimes(1);
      expect(input).toEqual(before);
    },
  );

  it.each([new Error('DB'), new EditorialVocabularyRepresentationError('DB')])(
    'keeps snapshot failure %s outside translation',
    async (sentinel) => {
      const spies = projectors();
      const rejected = adapter(fixture());
      rejected.$queryRaw.mockRejectedValue(sentinel);
      await expect(read(rejected.source)).rejects.toBe(sentinel);
      expect(rejected.$queryRaw).toHaveBeenCalledTimes(1);
      const { source, $queryRaw } = adapter(fixture());
      $queryRaw.mockResolvedValue([]);
      const observed = jest.spyOn(source, 'read');
      const pending = read(source);
      const snapshotRead = observed.mock.results[0].value as Promise<unknown>;
      const original: unknown = await snapshotRead.catch(
        (error: unknown) => error,
      );
      expect(original).toBeInstanceOf(Error);
      expect((original as Error).message).toBe(
        'Invalid vocabulary snapshot result',
      );
      await expect(pending).rejects.toBe(original);
      expect($queryRaw).toHaveBeenCalledTimes(1);
      expect(spies.v2).not.toHaveBeenCalled();
    },
  );

  it.each([
    new Error('runtime'),
    new TypeError('Expected a finite, acyclic JSON data tree'),
    new RangeError('runtime'),
    Symbol('runtime'),
  ])(
    'preserves whole-tree guard runtime sentinel %s without executing getters',
    async (sentinel) => {
      const getter = jest.fn<unknown, []>();
      const raw = new Proxy(
        {
          get value() {
            return getter();
          },
        },
        {
          ownKeys() {
            // Deliberately exercise preservation of non-Error thrown values.
            // eslint-disable-next-line @typescript-eslint/only-throw-error
            throw sentinel;
          },
        },
      );
      const source = { read: jest.fn().mockResolvedValue(raw) };
      await expect(read(source)).rejects.toBe(sentinel);
      expect(source.read).toHaveBeenCalledTimes(1);
      expect(getter).not.toHaveBeenCalled();
    },
  );

  it('preserves Unicode runtime failure identity', async () => {
    const sentinel = new Error('Unsupported Unicode runtime');
    jest
      .spyOn(unicode, 'editorialAliasComparisonKeyV1')
      .mockImplementation(() => {
        throw sentinel;
      });
    const { source } = adapter(fixture());
    await expect(read(source)).rejects.toBe(sentinel);
  });

  it.each([1, 2] as const)(
    'allows empty/custom metadata with stored column %s without full-production admission',
    async (minimumContractVersion) => {
      const input = fixture();
      input.families[0].minimumContractVersion = minimumContractVersion;
      input.families[0].bindings = [];
      input.definitions = [];
      freeze(input);
      const { source } = adapter(input);
      const result = await read(source);
      const output = result.vocabulary;
      expect(output.families).toHaveLength(1);
      expect(output.definitions).toEqual([]);
      const empty = adapter({
        metadata: input.metadata,
        families: [],
        definitions: [],
      });
      const emptyResult = await read(empty.source);
      expect(emptyResult.vocabulary.families).toEqual([]);
    },
  );

  it('awaits a deferred snapshot exactly once before materializing', async () => {
    let complete!: (value: unknown) => void;
    const source = {
      read: jest.fn(() => new Promise((resolve) => (complete = resolve))),
    };
    const spies = projectors();
    const pending = read(source);
    expect(source.read).toHaveBeenCalledTimes(1);
    expect(spies.v2).not.toHaveBeenCalled();
    complete(fixture());
    const result = await pending;
    expect(result).toBe(spies.v2.mock.results[0].value);
    expect(spies.v2).toHaveBeenCalledTimes(1);
    expect(source.read).toHaveBeenCalledTimes(1);
  });
});
