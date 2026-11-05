/** Display help attached AFTER the revision is computed: descriptions are not
 * vocabulary semantics, so they never enter the digest. Pure; returns the same
 * body when nothing applies and omits the key (never null) for undescribed codes.
 */
export function withDefinitionDescriptions<
  B extends { vocabulary: { definitions: { code: string }[] } },
>(body: B, descriptions: ReadonlyMap<string, string>): B {
  const usable = (code: string) => {
    const text = descriptions.get(code);
    return text !== undefined && text.trim().length > 0 ? text : undefined;
  };
  if (!body.vocabulary.definitions.some(({ code }) => usable(code)))
    return body;
  return {
    ...body,
    vocabulary: {
      ...body.vocabulary,
      definitions: body.vocabulary.definitions.map((definition) => {
        const description = usable(definition.code);
        return description === undefined
          ? definition
          : { ...definition, description };
      }),
    },
  };
}
