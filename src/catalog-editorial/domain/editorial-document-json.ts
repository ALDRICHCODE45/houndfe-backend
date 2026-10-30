/** Already-decoded JSON with finite numbers; callers establish this precondition. */
export type EditorialDocumentJson =
  | null
  | boolean
  | number
  | string
  | EditorialDocumentJson[]
  | { [key: string]: EditorialDocumentJson };
