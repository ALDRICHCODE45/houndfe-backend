/**
 * Slice B — SatCatalogService tests.
 *
 * Covers spec scenarios in tasks B.3.1 / B.3.2:
 *   - `search(q, opts)` returns `{items, limit, offset, total}`.
 *   - Empty/missing `q` returns `{items:[], limit, offset, total:0}` WITHOUT
 *     calling the repository (avoids accidental table scans).
 *   - `findByKey` delegates to the repository.
 *   - `assertExists(key)` throws `BadRequestException({error:'SAT_KEY_NOT_FOUND', message})`
 *     on a miss and passes on a hit — INCLUDING a retired hit (retired
 *     products must still resolve so editors can load legacy keys).
 *
 * Pure unit test: the repository is mocked. No DI container, no DB.
 */
import { BadRequestException } from '@nestjs/common';
import { SatCatalogService } from './sat-catalog.service';
import type { ISatKeyRepository } from './domain/sat-key.repository';

function makeRepo(overrides: Partial<ISatKeyRepository> = {}) {
  return {
    search: jest.fn(),
    findByKey: jest.fn(),
    exists: jest.fn(),
    ...overrides,
  } as jest.Mocked<ISatKeyRepository>;
}

describe('SatCatalogService.search (B.3.1)', () => {
  it('returns { items, limit, offset, total } when the repo returns rows', async () => {
    const items = [{ key: '01010101' }, { key: '01010102' }] as never;
    const repo = makeRepo({
      search: jest.fn().mockResolvedValue({ items, total: 42 }),
    });
    const svc = new SatCatalogService(repo);

    const result = await svc.search('aspirina', { limit: 20, offset: 0 });

    expect(result).toEqual({
      items,
      limit: 20,
      offset: 0,
      total: 42,
    });
    expect(repo.search).toHaveBeenCalledWith('aspirina', {
      limit: 20,
      offset: 0,
    });
  });

  it('returns empty items with total:0 on empty q WITHOUT calling the repo', async () => {
    const repo = makeRepo();
    const svc = new SatCatalogService(repo);

    const result = await svc.search('', { limit: 20, offset: 0 });

    expect(result).toEqual({ items: [], limit: 20, offset: 0, total: 0 });
    expect(repo.search).not.toHaveBeenCalled();
  });

  it('returns empty items on whitespace-only q WITHOUT calling the repo', async () => {
    const repo = makeRepo();
    const svc = new SatCatalogService(repo);

    const result = await svc.search('   ', { limit: 20, offset: 0 });

    expect(result).toEqual({ items: [], limit: 20, offset: 0, total: 0 });
    expect(repo.search).not.toHaveBeenCalled();
  });

  it('forwards limit / offset verbatim', async () => {
    const repo = makeRepo({
      search: jest.fn().mockResolvedValue({ items: [], total: 0 }),
    });
    const svc = new SatCatalogService(repo);

    await svc.search('a', { limit: 7, offset: 35 });

    expect(repo.search).toHaveBeenCalledWith('a', { limit: 7, offset: 35 });
  });
});

describe('SatCatalogService.findByKey (B.3.2)', () => {
  it('delegates to repo.findByKey and returns the row when present', async () => {
    const repo = makeRepo({
      findByKey: jest.fn().mockResolvedValue({ key: '01010101' } as never),
    });
    const svc = new SatCatalogService(repo);

    const result = await svc.findByKey('01010101');

    expect(result).toEqual({ key: '01010101' });
    expect(repo.findByKey).toHaveBeenCalledWith('01010101');
  });

  it('returns null when the repo has no row', async () => {
    const repo = makeRepo({ findByKey: jest.fn().mockResolvedValue(null) });
    const svc = new SatCatalogService(repo);

    await expect(svc.findByKey('00000000')).resolves.toBeNull();
  });
});

describe('SatCatalogService.assertExists (B.3.2)', () => {
  it('passes silently when the key exists', async () => {
    const repo = makeRepo({ exists: jest.fn().mockResolvedValue(true) });
    const svc = new SatCatalogService(repo);

    await expect(svc.assertExists('01010101')).resolves.toBeUndefined();
    expect(repo.exists).toHaveBeenCalledWith('01010101');
  });

  it('passes silently on a RETIRED hit (legacy keys still resolve)', async () => {
    const repo = makeRepo({ exists: jest.fn().mockResolvedValue(true) });

    // Retired-or-not is decided in the repo (findByKey/exists bypass
    // activeClause). The service only cares that the row is known.
    const svc = new SatCatalogService(repo);
    await expect(svc.assertExists('99999999')).resolves.toBeUndefined();
  });

  it('throws BadRequestException({ error: "SAT_KEY_NOT_FOUND", message }) on miss', async () => {
    const repo = makeRepo({ exists: jest.fn().mockResolvedValue(false) });
    const svc = new SatCatalogService(repo);

    await expect(svc.assertExists('00000000')).rejects.toBeInstanceOf(
      BadRequestException,
    );

    try {
      await svc.assertExists('00000000');
    } catch (err) {
      const resp = (err as BadRequestException).getResponse() as Record<
        string,
        unknown
      >;
      expect(resp.error).toBe('SAT_KEY_NOT_FOUND');
      expect(typeof resp.message).toBe('string');
      expect((resp.message as string).length).toBeGreaterThan(0);
    }
  });
});
