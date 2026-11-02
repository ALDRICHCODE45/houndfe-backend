import type { PrismaClient } from '@prisma/client';
import { installProductionVocabulary } from './editorial-production-vocabulary-install';

describe('production vocabulary installation input', () => {
  it.each(['', 'x'.repeat(64), 'a'.repeat(63)])(
    'rejects malformed before-image hashes before opening a transaction (%s)',
    async (hash) => {
      const transaction = jest.fn();
      const prisma = { $transaction: transaction } as unknown as Pick<
        PrismaClient,
        '$transaction'
      >;
      await expect(installProductionVocabulary(prisma, hash)).rejects.toThrow(
        'INVALID_VOCABULARY_BEFORE_IMAGE',
      );
      expect(transaction).not.toHaveBeenCalled();
    },
  );
});
