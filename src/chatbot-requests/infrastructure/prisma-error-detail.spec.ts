import { Prisma } from '@prisma/client';
import { describePrismaError } from './prisma-error-detail';

const known = (code: string, meta?: Record<string, unknown>, message = 'm') =>
  new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: 'test',
    meta,
  });

describe('describePrismaError (A5: a log detail with no PII)', () => {
  it('names the error, its Prisma code and the constraint target', () => {
    expect(
      describePrismaError(known('P2002', { target: ['tenantId', 'folio'] })),
    ).toBe('PrismaClientKnownRequestError code=P2002 target=tenantId,folio');
    expect(describePrismaError(known('P2002', { target: 'folio_key' }))).toBe(
      'PrismaClientKnownRequestError code=P2002 target=folio_key',
    );
    expect(
      describePrismaError(known('P2003', { field_name: 'tenantId' })),
    ).toBe('PrismaClientKnownRequestError code=P2003 target=tenantId');
  });

  it('never prints the message or other meta (they can carry customer values)', () => {
    const text = describePrismaError(
      known(
        'P2025',
        { cause: 'phone 5255123456 not found', modelName: 'ChatbotRequest' },
        'Unique failed on phone 5255123456',
      ),
    );
    expect(text).toBe(
      'PrismaClientKnownRequestError code=P2025 target=ChatbotRequest',
    );
    expect(text).not.toMatch(/5255|phone/);
  });

  it('a known error with no meta has only a code; other errors only a name', () => {
    expect(describePrismaError(known('P2034'))).toBe(
      'PrismaClientKnownRequestError code=P2034',
    );
    expect(describePrismaError(new TypeError('boom 5255'))).toBe('TypeError');
    expect(describePrismaError('weird')).toBe('unknown');
  });
});
