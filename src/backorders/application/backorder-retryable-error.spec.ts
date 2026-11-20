import { Prisma } from '@prisma/client';
import { isRetryableTransactionError } from './backorder-retryable-error';

const known = (code: string, meta?: Record<string, unknown>) =>
  new Prisma.PrismaClientKnownRequestError('boom', {
    code,
    clientVersion: 'test',
    meta,
  });

describe('isRetryableTransactionError (backorder routes → 503 BACKORDER_RETRY_REQUIRED)', () => {
  it.each(['P2034', 'P2028', 'P2024'])('%s is retryable', (code) => {
    expect(isRetryableTransactionError(known(code))).toBe(true);
  });

  it('a deadlock raised by a raw query (P2010 with meta.code 40P01) is retryable', () => {
    expect(
      isRetryableTransactionError(
        known('P2010', { code: '40P01', message: 'deadlock detected' }),
      ),
    ).toBe(true);
  });

  it('a deadlock carried only in the message of an unknown request error is retryable', () => {
    expect(
      isRetryableTransactionError(
        new Prisma.PrismaClientUnknownRequestError(
          'Raw query failed. Code: `40P01`. Message: `deadlock detected`',
          { clientVersion: 'test' },
        ),
      ),
    ).toBe(true);
  });

  it('other raw-query failures and unrelated errors are not retryable', () => {
    expect(isRetryableTransactionError(known('P2010', { code: '22P02' }))).toBe(
      false,
    );
    expect(isRetryableTransactionError(known('P2002'))).toBe(false);
    expect(isRetryableTransactionError(new Error('deadlock detected'))).toBe(
      false,
    );
    expect(isRetryableTransactionError(undefined)).toBe(false);
  });
});
