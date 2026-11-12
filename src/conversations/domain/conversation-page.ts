/**
 * DOMAIN: the paging query of `GET /chatbot-requests/:id/conversation`
 * (contract §3.6, §12.5): `?before=<seq>&limit=50` (older page) or
 * `?after=<seq>&limit=50` (newer messages, for polling), never both. No cursor
 * is the latest page. `seq` is the only order (never a clock).
 */
import { InvalidArgumentError } from '../../shared/domain/domain-error';

export const CONVERSATION_PAGE = { defaultLimit: 50, maxLimit: 100 } as const;

export type ConversationPageQuery =
  | { mode: 'latest'; limit: number }
  | { mode: 'before'; seq: number; limit: number }
  | { mode: 'after'; seq: number; limit: number };

const invalid = (): never => {
  throw new InvalidArgumentError('Invalid conversation page');
};

function parseSeq(value: unknown, min: number): number {
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) return invalid();
  const n = Number(value);
  return n >= min ? n : invalid();
}

export function parseConversationPageQuery(
  query: Record<string, unknown>,
): ConversationPageQuery {
  for (const key of Object.keys(query)) {
    if (key !== 'before' && key !== 'after' && key !== 'limit') invalid();
  }
  const limit =
    query.limit === undefined
      ? CONVERSATION_PAGE.defaultLimit
      : parseSeq(query.limit, 1);
  if (limit > CONVERSATION_PAGE.maxLimit) invalid();
  if (query.before !== undefined && query.after !== undefined) invalid();
  if (query.before !== undefined) {
    // The first message is seq 1, so `before=1` could never return anything.
    return { mode: 'before', seq: parseSeq(query.before, 2), limit };
  }
  if (query.after !== undefined) {
    return { mode: 'after', seq: parseSeq(query.after, 0), limit };
  }
  return { mode: 'latest', limit };
}
