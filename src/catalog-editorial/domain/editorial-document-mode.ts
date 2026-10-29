import { isRecognizableDocumentV2 } from './editorial-document-recognition-v2';

/** Already-decoded JSON with finite numbers; callers establish this precondition. */
export type EditorialDocumentJson =
  | null
  | boolean
  | number
  | string
  | EditorialDocumentJson[]
  | { [key: string]: EditorialDocumentJson };

export type EditorialDocumentMode = 'legacy' | 'production-v2' | 'unsupported';

/** Historical mode only: no adoption, fresh validation or conversion. */
export function classifyEditorialDocumentMode(
  document: EditorialDocumentJson,
): EditorialDocumentMode {
  if (document === null || typeof document !== 'object') return 'legacy';

  const version = Object.getOwnPropertyDescriptor(document, 'schemaVersion');
  if (version === undefined) return 'legacy';
  if (!('value' in version) || version.value !== 2) return 'unsupported';

  return isRecognizableDocumentV2(document) ? 'production-v2' : 'unsupported';
}
