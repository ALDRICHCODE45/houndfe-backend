/** Keep the full query; only toggle one ASCII space for an unambiguous integer mg. */
export function chatbotMgSpacingQueries(q: string): string[] {
  // Deliberately skip punctuation/whitespace that could encode complex doses.
  if (/[^\p{L}0-9 ]| {2}/u.test(q)) return [q];
  const doses = q.match(/\d *(?:mg|mcg|[µμu]g|kg|g|ml|l|iu|ui|meq)\b/gi);
  if (doses?.length !== 1) return [q];
  const match = /(^| )([0-9]+)( ?)(mg)(?= |$)/i.exec(q);
  if (!match) return [q];
  const [, prefix, digits, space, unit] = match;
  const replacement = `${prefix}${digits}${space ? '' : ' '}${unit}`;
  return [
    q,
    q.slice(0, match.index) +
      replacement +
      q.slice(match.index + match[0].length),
  ];
}
