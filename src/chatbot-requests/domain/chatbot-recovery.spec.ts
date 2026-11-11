import { InvalidArgumentError } from '../../shared/domain/domain-error';
import {
  encodeRecoveryPage,
  parseRecoveryQuery,
  RECOVERY_LIMITS,
} from './chatbot-recovery';

const ID = '9a7e4c1e-6d7a-4c1e-9a52-3f1d2b6a7c10';
const SINCE = '2026-11-10T16:20:00.000Z';

describe('recovery query (§3.3: 410 CURSOR_EXPIRED → GET /chatbot-api/requests?status=open&updatedSince=)', () => {
  it('defaults to 50 items, no lower bound and the first page', () => {
    expect(parseRecoveryQuery({ status: 'open' })).toEqual({
      updatedSince: null,
      page: null,
      limit: RECOVERY_LIMITS.defaultLimit,
    });
  });

  it('parses updatedSince as a canonical UTC instant, and the limit', () => {
    const parsed = parseRecoveryQuery({
      status: 'open',
      updatedSince: SINCE,
      limit: '10',
    });
    expect(parsed.updatedSince?.toISOString()).toBe(SINCE);
    expect(parsed.limit).toBe(10);
  });

  it('round-trips the page cursor with its updatedAt, id and feed cursor', () => {
    const token = encodeRecoveryPage({
      updatedAt: new Date(SINCE),
      id: ID,
      feedCursor: 1842n,
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    const parsed = parseRecoveryQuery({ status: 'open', cursor: token });
    expect(parsed.page?.updatedAt.toISOString()).toBe(SINCE);
    expect(parsed.page).toMatchObject({ id: ID, feedCursor: 1842n });
  });

  it.each([
    ['a missing status', {}],
    ['a status other than open', { status: 'closed' }],
    ['an unknown key', { status: 'open', tenantId: 't' }],
    [
      'a non-canonical updatedSince',
      { status: 'open', updatedSince: '2026-11-10' },
    ],
    [
      'an updatedSince without milliseconds',
      { status: 'open', updatedSince: '2026-11-10T16:20:00Z' },
    ],
    [
      'an impossible updatedSince',
      { status: 'open', updatedSince: '2026-13-45T99:99:99.000Z' },
    ],
    ['a limit of 0', { status: 'open', limit: '0' }],
    ['a limit of 51', { status: 'open', limit: '51' }],
    ['a non-numeric limit', { status: 'open', limit: 'x' }],
    ['a cursor that is not base64url JSON', { status: 'open', cursor: '%%%' }],
    ['an empty cursor', { status: 'open', cursor: '' }],
    [
      'a cursor with a bad id',
      {
        status: 'open',
        cursor: Buffer.from(
          JSON.stringify({ u: SINCE, i: 'nope', f: '1' }),
        ).toString('base64url'),
      },
    ],
    [
      'a cursor with extra keys',
      {
        status: 'open',
        cursor: Buffer.from(
          JSON.stringify({ u: SINCE, i: ID, f: '1', x: 1 }),
        ).toString('base64url'),
      },
    ],
    ['a repeated status (array)', { status: ['open', 'open'] }],
  ])('rejects %s with a 400-class error', (_label, query) => {
    expect(() => parseRecoveryQuery(query)).toThrow(InvalidArgumentError);
  });
});
