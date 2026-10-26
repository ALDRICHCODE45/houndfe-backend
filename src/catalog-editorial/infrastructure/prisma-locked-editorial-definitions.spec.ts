import type { Prisma } from '@prisma/client';
import { emptyDocument } from '../domain/document';
import { readLockedEditorialDefinitions } from './prisma-locked-editorial-definitions';

it('rejects accessors without invoking them or querying', async () => {
  const getter = jest.fn(() => 'f');
  const document = Object.defineProperty(emptyDocument(), 'familyCode', {
    get: getter,
  });
  const query = jest.fn();
  await expect(
    readLockedEditorialDefinitions(
      { $queryRaw: query } as unknown as Prisma.TransactionClient,
      [document],
    ),
  ).rejects.toThrow('MALFORMED');
  expect(getter).not.toHaveBeenCalled();
  expect(query).not.toHaveBeenCalled();
});
it.each([undefined, () => 'f', new Date(), Number.NaN])(
  'rejects unsupported JSON values before queries (%s)',
  async (value) => {
    const query = jest.fn();
    await expect(
      readLockedEditorialDefinitions(
        { $queryRaw: query } as unknown as Prisma.TransactionClient,
        [{ ...emptyDocument(), commercialTitle: value }],
      ),
    ).rejects.toThrow('MALFORMED');
    expect(query).not.toHaveBeenCalled();
  },
);
