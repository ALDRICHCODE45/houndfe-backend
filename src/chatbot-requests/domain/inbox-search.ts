/**
 * DOMAIN: the `q` of `GET /chatbot-requests/groups` (contract §3.8). Pure
 * parsing; the SQL lives in the read store.
 *
 *   - `S-000123` (any case, any padding): an exact folio.
 *   - digits and phone separators only: a phone search, allowed only for a
 *     caller with `read:CustomerPhone`. Without it the search matches nothing
 *     (`none`), so the endpoint cannot be used to test whether a number is a
 *     customer (R12). Text that mixes letters and digits is a name search and
 *     is never matched against a phone.
 *   - anything else: customer name, case and accent insensitive, every word
 *     contained in the name (at most four words).
 */
export type InboxSearch =
  | { kind: 'absent' }
  | { kind: 'none' }
  | { kind: 'folio'; folio: number }
  | { kind: 'phone'; digits: string }
  | { kind: 'name'; tokens: string[] };

export const MAX_SEARCH_LENGTH = 100;
const MAX_TOKENS = 4;
const FOLIO = /^S-0*(\d{1,9})$/i;
const PHONE_ONLY = /^[\d\s+().-]+$/;

/** Lower case, accents removed; `ñ` folds to `n` like the SQL `translate`. */
export const foldText = (text: string): string =>
  text.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const escapeLike = (token: string) => token.replace(/[\\%_]/g, '\\$&');

export function parseInboxSearch(
  raw: string | undefined,
  options: { canSearchPhone: boolean },
): InboxSearch {
  const q = raw?.trim() ?? '';
  if (q === '') return { kind: 'absent' };
  const folio = FOLIO.exec(q);
  if (folio && Number(folio[1]) > 0) {
    return { kind: 'folio', folio: Number(folio[1]) };
  }
  if (PHONE_ONLY.test(q)) {
    const digits = q.replace(/\D/g, '');
    if (digits === '') return { kind: 'none' };
    return options.canSearchPhone
      ? { kind: 'phone', digits }
      : { kind: 'none' };
  }
  const tokens = foldText(q)
    .split(/\s+/)
    .filter((token) => token !== '')
    .slice(0, MAX_TOKENS)
    .map(escapeLike);
  return tokens.length > 0 ? { kind: 'name', tokens } : { kind: 'none' };
}
