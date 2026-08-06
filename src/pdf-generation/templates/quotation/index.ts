/**
 * Barrel export for the quotation PDF template.
 *
 * Mirrors the receipt template barrel — keeps the template imports
 * shallow from the service / registry side. The `QuotationDocumentProps`
 * type export comes BEFORE the component export so callers can
 * `import { QuotationA4Document, type QuotationDocumentProps }` in a
 * single line (matches the receipt barrel pattern).
 */
export type { QuotationDocumentProps } from './quotation-a4.document';
export { QuotationA4Document } from './quotation-a4.document';
