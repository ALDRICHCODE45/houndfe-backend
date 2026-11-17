/**
 * Chatbot-only word search helpers (opt-in via `chatbotTokenSearch`).
 *
 * Accent folding is done WITHOUT the `unaccent` extension (no migration):
 * the SQL side applies `translate()` with the exact same character table as
 * `foldSearchText`, so both sides fold identically by construction.
 */

// Lowercase and uppercase Spanish/Latin accents mapped to their base letter.
// Uppercase is listed so folding works even under a C/POSIX collation where
// lower() does not touch non-ASCII letters.
export const ACCENT_FROM = 'áàâäãéèêëíìîïóòôöõúùûüñçÁÀÂÄÃÉÈÊËÍÌÎÏÓÒÔÖÕÚÙÛÜÑÇ';
export const ACCENT_TO = 'aaaaaeeeeiiiiooooouuuuncAAAAAEEEEIIIIOOOOOUUUUNC';

const ACCENT_MAP = new Map(
  [...ACCENT_FROM].map((from, i) => [from, ACCENT_TO[i]] as const),
);

/**
 * Trivial Spanish stopwords dropped from the query. Needed because AND over
 * every word would otherwise require product text to literally contain
 * "para"/"de"/... (e.g. "alimento para gato"), and in the OR fallback they
 * would rank unrelated "... para perro" products equal to real matches.
 * Kept to function words only; no synonyms.
 */
const STOPWORDS = new Set([
  'a',
  'al',
  'con',
  'de',
  'del',
  'e',
  'el',
  'en',
  'la',
  'las',
  'lo',
  'los',
  'o',
  'para',
  'por',
  'u',
  'un',
  'una',
  'y',
]);

/** Lowercase + strip accents using the same table as the SQL `translate()`. */
export function foldSearchText(text: string): string {
  let out = '';
  for (const ch of text) out += ACCENT_MAP.get(ch) ?? ch;
  return out.toLowerCase();
}

function tokenize(query: string): string[] {
  const words = foldSearchText(query)
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0);
  const meaningful = words.filter((w) => !STOPWORDS.has(w));
  // A query made only of stopwords keeps them rather than matching nothing.
  const kept = meaningful.length > 0 ? meaningful : words;
  return [...new Set(kept)];
}

/**
 * One token list per query variant (the mg-spacing normalization can yield
 * two). Blank variants and duplicate token lists are removed; an empty result
 * means the query has no searchable words.
 */
export function chatbotSearchTokenSets(queries: string[]): string[][] {
  const sets: string[][] = [];
  const seen = new Set<string>();
  for (const query of queries) {
    const tokens = tokenize(query);
    if (tokens.length === 0) continue;
    const key = tokens.join('\u0000');
    if (seen.has(key)) continue;
    seen.add(key);
    sets.push(tokens);
  }
  return sets;
}
