import { UpdateCatalogSettingsUseCase } from './update-catalog-settings.use-case';
import { CatalogSettingsNotFoundError } from './get-catalog-settings.use-case';
import {
  CatalogSettingsInvariantError,
  TenantCatalogSettings,
  type TenantBaseProps,
} from '../domain/tenant-catalog-settings.aggregate';
import { TenantCatalogPriceListBinding } from '../domain/tenant-catalog-price-list.entity';
import type { ICatalogSettingsRepository } from '../domain/catalog-settings.repository';
import type { UpdateCatalogSettingsDto } from '../dto/update-catalog-settings.dto';

const repo = () =>
  ({
    findByTenantId: jest.fn(),
    replace: jest.fn(),
    findGlobalPriceListsByIds: jest.fn(),
    countDefaultContextCoverage: jest.fn(),
  }) satisfies ICatalogSettingsRepository;

const list = (id: string) => ({ id, name: id });

const binding = (globalId: string, isDefault: boolean) =>
  TenantCatalogPriceListBinding.fromPersistence({
    id: `b-${globalId}`,
    tenantId: 't1',
    globalPriceListId: globalId,
    isCatalogDefault: isDefault,
    createdAt: new Date('2024-01-01'),
    updatedAt: new Date('2024-01-01'),
    globalPriceList: { id: globalId, name: globalId },
  });

const settings = (
  bindings: ReturnType<typeof binding>[],
  overrides: Partial<TenantBaseProps> = {},
) =>
  TenantCatalogSettings.fromPersistence({
    tenant: {
      tenantId: 't1',
      isActive: true,
      catalogPublished: false,
      catalogStockPresentationDefault: 'SYSTEM_STATUS',
      catalogStockPresentationDefaultCustomQty: null,
      updatedAt: new Date('2024-01-01'),
      ...overrides,
    },
    bindings,
  });

/** Wires repo mocks (echo `replace` unless overridden) and runs the use case. */
const run = (
  current: TenantCatalogSettings,
  data: UpdateCatalogSettingsDto,
  opts: {
    found?: Array<{ id: string; name: string }>;
    saved?: TenantCatalogSettings;
    replaceError?: unknown;
    coverage?: number;
    coverageError?: unknown;
  } = {},
) => {
  const r = repo();
  r.findByTenantId.mockResolvedValue(current);
  r.findGlobalPriceListsByIds.mockResolvedValue(opts.found ?? []);
  if (opts.replaceError) r.replace.mockRejectedValue(opts.replaceError);
  else
    r.replace.mockImplementation((s: TenantCatalogSettings) =>
      Promise.resolve(opts.saved ?? s),
    );
  if (opts.coverageError)
    r.countDefaultContextCoverage.mockRejectedValue(opts.coverageError);
  else r.countDefaultContextCoverage.mockResolvedValue(opts.coverage ?? 0);
  const input = { tenantId: 't1', actorUserId: 'actor-1', data };
  return { r, promise: new UpdateCatalogSettingsUseCase(r).execute(input) };
};

const persisted = (r: ReturnType<typeof repo>) =>
  r.replace.mock.calls[0] as unknown as [TenantCatalogSettings, string];

const rejects = (promise: Promise<unknown>, code: string) =>
  expect(promise).rejects.toMatchObject({ code });

const backstop = (code: string) => new CatalogSettingsInvariantError(code, 'x');

describe('UpdateCatalogSettingsUseCase', () => {
  it('throws the GET-consistent not-found error and never writes', async () => {
    const r = repo();
    r.findByTenantId.mockResolvedValue(null);
    const error = await new UpdateCatalogSettingsUseCase(r)
      .execute({ tenantId: 't1', actorUserId: 'actor-1', data: {} })
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(CatalogSettingsNotFoundError);
    expect(error).toMatchObject({ tenantId: 't1' });
    expect(r.replace).not.toHaveBeenCalled();
  });

  it('omitted fields keep current values; replace is atomic with actor', async () => {
    const current = settings([binding('gpl-1', true)], {
      catalogStockPresentationDefault: 'ABSTRACT_STATUS',
    });
    const { r, promise } = run(current, {}, { coverage: 3 });
    const response = await promise;
    expect(r.replace).toHaveBeenCalledTimes(1);
    const [saved, actorUserId] = persisted(r);
    expect(actorUserId).toBe('actor-1');
    expect(saved).toBeInstanceOf(TenantCatalogSettings);
    expect(saved.catalogPublished).toBe(false);
    expect(saved.stockPresentationDefault.mode).toBe('ABSTRACT_STATUS');
    expect(saved.stockPresentationDefault.customQuantity).toBeNull();
    expect(saved.defaultBinding?.globalPriceListId).toBe('gpl-1');
    expect(response.warnings).toEqual([]);
  });

  it('applies PATCH fields and maps the saved aggregate like GET', async () => {
    const { r, promise } = run(
      settings([binding('gpl-1', true), binding('gpl-2', false)]),
      { catalogPublished: true, publicPriceListIds: ['gpl-1', 'gpl-3'] },
      { found: [list('gpl-1'), list('gpl-3')], coverage: 2 },
    );
    const response = await promise;
    expect(r.findGlobalPriceListsByIds).toHaveBeenCalledWith([
      'gpl-1',
      'gpl-3',
    ]);
    const saved = persisted(r)[0];
    expect(saved.catalogPublished).toBe(true);
    const ids = saved.bindings.map((b) => b.globalPriceListId);
    expect(ids).toEqual(['gpl-1', 'gpl-3']);
    expect(response).toMatchObject({
      effectivePublication: true,
      priceContexts: [
        { priceListId: 'gpl-1', name: 'gpl-1', isCatalogDefault: true },
        { priceListId: 'gpl-3', name: 'gpl-3', isCatalogDefault: false },
      ],
    });
  });

  it('rejects unknown list ids and non-public defaults before any write', async () => {
    const current = settings([binding('gpl-1', true), binding('gpl-2', false)]);
    const ghost = run(
      current,
      { publicPriceListIds: ['gpl-1', 'gpl-ghost'] },
      { found: [list('gpl-1')] },
    );
    await rejects(ghost.promise, 'UNKNOWN_GLOBAL_PRICE_LIST');
    expect(ghost.r.replace).not.toHaveBeenCalled();
    // Omitted default keeps gpl-1, which is dropped from the new set.
    const dropped = run(
      current,
      { publicPriceListIds: ['gpl-2'] },
      {
        found: [list('gpl-2')],
      },
    );
    await rejects(dropped.promise, 'DEFAULT_NOT_PUBLIC');
    expect(dropped.r.replace).not.toHaveBeenCalled();
  });

  it('selects an explicit default; PATCH warnings match GET', async () => {
    const { r, promise } = run(
      settings([binding('gpl-1', true), binding('gpl-2', false)]),
      { catalogDefaultPriceListId: 'gpl-2' },
      { found: [list('gpl-1'), list('gpl-2')] },
    );
    const response = await promise;
    const [saved] = persisted(r);
    expect(saved.defaultBinding?.globalPriceListId).toBe('gpl-2');
    expect(saved.bindings.filter((b) => b.isCatalogDefault)).toHaveLength(1);
    expect(response.warnings).toEqual(['DEFAULT_CONTEXT_HAS_NO_VALID_PRICES']);
    expect(r.countDefaultContextCoverage).toHaveBeenCalledWith('t1', 'gpl-2');
  });

  it('propagates aggregate invariants and clears default via explicit null', async () => {
    const current = settings([binding('gpl-1', true)]);
    // Null default with a non-empty set violates default cardinality.
    const cleared = run(current, { catalogDefaultPriceListId: null });
    await rejects(cleared.promise, 'DEFAULT_CARDINALITY');
    const published = run(settings([]), { catalogPublished: true });
    await rejects(published.promise, 'PUBLISH_REQUIRES_DEFAULT');
    expect(published.r.replace).not.toHaveBeenCalled();
    const { r, promise } = run(current, {
      publicPriceListIds: [],
      catalogDefaultPriceListId: null,
    });
    await promise;
    const [saved] = persisted(r);
    expect(saved.bindings).toHaveLength(0);
    expect(saved.defaultBinding).toBeNull();
  });

  it('applies nested stock presentation as a whole approved setting', async () => {
    const current = settings([binding('gpl-1', true)]);
    const custom = run(current, {
      stockPresentationDefault: { mode: 'CUSTOM_QUANTITY', customQuantity: 5 },
    });
    await custom.promise;
    expect(persisted(custom.r)[0].stockPresentationDefault).toEqual({
      mode: 'CUSTOM_QUANTITY',
      customQuantity: 5,
    });
    const hidden = run(current, {
      stockPresentationDefault: { mode: 'HIDDEN' },
    });
    await hidden.promise;
    expect(persisted(hidden.r)[0].stockPresentationDefault).toEqual({
      mode: 'HIDDEN',
      customQuantity: null,
    });
  });

  it('resolves coverage before the write; a coverage read failure prevents replace', async () => {
    const { r, promise } = run(
      settings([binding('gpl-1', true)]),
      {},
      { coverageError: new Error('coverage read failed') },
    );
    await expect(promise).rejects.toThrow('coverage read failed');
    expect(r.replace).not.toHaveBeenCalled();
  });

  it('propagates persistence failures from the atomic replace backstop', async () => {
    const { promise } = run(
      settings([binding('gpl-1', true)]),
      {},
      {
        replaceError: backstop('UNKNOWN_GLOBAL_PRICE_LIST'),
      },
    );
    await rejects(promise, 'UNKNOWN_GLOBAL_PRICE_LIST');
  });
});
