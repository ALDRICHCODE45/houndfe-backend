/**
 * Receipt destination check (N18). Compares the destination the chatbot read
 * from a transfer receipt with the tenant's ACTIVE payment accounts. Computed
 * once at upload and persisted inside the receipt `mismatch` snapshot; never
 * recomputed, because the business account may change later. It is a review
 * hint only: it never rejects a receipt and never changes the bot message.
 *
 * Rule (owner decision S4):
 *   1. `destinationAccountLast4` present: 'match' when it equals the last 4
 *      digits of the CLABE or the account number of ANY active account
 *      (digits only, separators ignored); otherwise 'mismatch'.
 *   2. No last4 but `destinationName` present: 'match' when the name looks
 *      like ANY active beneficiary (see `namesMatch`); otherwise 'mismatch'.
 *   3. Neither present, or no active account: 'unknown' (no alert).
 * The bank never decides (Mercado Pago shows up under different names).
 */
export type DestinationCheck = 'match' | 'mismatch' | 'unknown';

export type ActivePaymentAccount = {
  beneficiary: string;
  clabe: string;
  accountNumber: string;
};

export type DestinationEvidence = {
  destinationAccountLast4?: string | null;
  destinationName?: string | null;
};

const DESTINATION_CHECKS: ReadonlySet<string> = new Set([
  'match',
  'mismatch',
  'unknown',
]);

/** Short tokens and these connectors carry no identity. */
const MIN_TOKEN_LENGTH = 3;
const STOPWORDS: ReadonlySet<string> = new Set(['del', 'las', 'los']);

/** True when the extraction carries something the check can decide on. */
export function hasDestinationEvidence(
  extracted: DestinationEvidence | null | undefined,
): boolean {
  return Boolean(
    extracted?.destinationAccountLast4 || extracted?.destinationName,
  );
}

export function computeDestinationCheck(
  input: DestinationEvidence & { accounts: ActivePaymentAccount[] },
): DestinationCheck {
  if (input.accounts.length === 0) return 'unknown';
  const last4 = input.destinationAccountLast4;
  if (last4) {
    const known = input.accounts.flatMap((account) =>
      [account.clabe, account.accountNumber]
        .map((value) => value.replace(/\D/g, ''))
        .filter((digits) => digits.length >= 4)
        .map((digits) => digits.slice(-4)),
    );
    return known.includes(last4) ? 'match' : 'mismatch';
  }
  const name = input.destinationName;
  if (name) {
    return input.accounts.some((account) =>
      namesMatch(name, account.beneficiary),
    )
      ? 'match'
      : 'mismatch';
  }
  return 'unknown';
}

/**
 * Deterministic name similarity. Both names are normalized (lowercase,
 * accents stripped, any non-alphanumeric run turned into one space) and
 * split into significant tokens (length >= 3, not `del`/`las`/`los`).
 * With S = the smaller token set, the names match when they share at least
 * min(2, |S|) tokens: two shared tokens in general ("Diana Vazquez" vs
 * "Diana Berenice Vazquez"), or the single token of a one-token name. One
 * shared surname is not enough ("Abril Alejandra Vazquez Ramos" vs "Diana
 * Berenice Vazquez" is a mismatch). A name without significant tokens never
 * matches.
 */
export function namesMatch(a: string, b: string): boolean {
  const left = significantTokens(a);
  const right = significantTokens(b);
  const smaller = left.size <= right.size ? left : right;
  const larger = smaller === left ? right : left;
  if (smaller.size === 0) return false;
  let shared = 0;
  for (const token of smaller) if (larger.has(token)) shared += 1;
  return shared >= Math.min(2, smaller.size);
}

function significantTokens(name: string): Set<string> {
  const normalized = name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
  return new Set(
    normalized
      .split(' ')
      .filter(
        (token) => token.length >= MIN_TOKEN_LENGTH && !STOPWORDS.has(token),
      ),
  );
}

/** Persisted value; rows without one (older or no evidence) are 'unknown'. */
export function readDestinationCheck(mismatch: unknown): DestinationCheck {
  const value =
    typeof mismatch === 'object' && mismatch !== null
      ? (mismatch as { destinationCheck?: unknown }).destinationCheck
      : undefined;
  return typeof value === 'string' && DESTINATION_CHECKS.has(value)
    ? (value as DestinationCheck)
    : 'unknown';
}
