import { canonicalEditorialJson } from './editorial-canonical-json';
import { UNICODE17_CASE_FOLD } from './editorial-unicode17-case-fold.generated';

// Literal Unicode White_Space: all 25 code points, not ECMAScript \s/trim.
const WHITE_SPACE_25 =
  // eslint-disable-next-line no-control-regex -- Unicode White_Space includes U+0009..000D.
  /[\u0009-\u000d\u0020\u0085\u00a0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000]+/gu;
const MARK = /\p{Mark}/u;
const DIACRITIC = /\p{Diacritic}/u;

/** collision-key-ucd17-v1 only; not a namespace validator or stored text rewrite. */
export function editorialAliasComparisonKeyV1(input: unknown): string {
  // Native normalization and properties must agree with the pinned folding data.
  // Check at use, before even validating input; importing remains harmless.
  if (process.versions.unicode !== '17.0') {
    throw new Error('collision-key-ucd17-v1 requires Unicode 17.0');
  }
  if (typeof input !== 'string')
    throw new TypeError('Expected a scalar string');
  canonicalEditorialJson(input); // Shared scalar validity guard; no coercion.
  const folded = Array.from(input.normalize('NFD'), (character) => {
    return UNICODE17_CASE_FOLD[character.codePointAt(0)!] ?? character;
  }).join('');
  return Array.from(folded.normalize('NFD'))
    .filter((character) => !(MARK.test(character) && DIACRITIC.test(character)))
    .join('')
    .replace(WHITE_SPACE_25, ' ')
    .replace(/^ +| +$/g, '');
}
