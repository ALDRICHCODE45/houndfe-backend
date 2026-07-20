/**
 * IPdfDocument — pluggable document-type contract.
 *
 * Every PDF template (receipt A4, receipt ticket, future invoice,
 * report, quote) implements this interface. The template registry
 * (`templates/registry.ts`, WU3) maps a `FormatKey` to an `IPdfDocument`
 * instance, and `PdfGenerationService.render()` (WU4) calls
 * `renderToStream(data)` to obtain a Node `Readable` it can pipe back
 * to the HTTP response.
 *
 * Why an adapter interface instead of registry-of-React-components?
 *   - Keeps `PdfGenerationService` framework-agnostic: it never imports
 *     `@react-pdf/renderer` directly. The template adapter owns the
 *     React→PDF composition.
 *   - Each template can register one custom font, one hyphenation
 *     callback, or one styling pass — without leaking those choices
 *     into the service layer.
 *   - Adding a new document type (invoice-a4, report-a4, quote-a4) is a
 *     pure addition: implement `IPdfDocument`, register the format key.
 *     No edits to sales, tenants, or pdf-generation service code.
 *
 * Streaming contract: implementations MUST return a Node `Readable`
 * (NOT a fully-buffered `Buffer`). `PdfGenerationService` will pipe the
 * stream straight into the Express response, so the spec's 2-second
 * performance budget holds even for large receipts.
 */
import type { Readable } from 'node:stream';

/**
 * Raw data passed to a template at render time. Templates are
 * responsible for narrowing this into the shape they expect
 * (e.g. `ReceiptDocumentProps` for receipt templates).
 *
 * `unknown` rather than `any` so adapters must explicitly cast —
 * catches contract drift at compile time when a template's data
 * shape evolves.
 */
export type PdfDocumentData = Record<string, unknown>;

/**
 * The single-method contract every PDF template implements.
 *
 * Lifecycle expectations for implementors:
 *   - `renderToStream` MUST be safe to call concurrently from multiple
 *     requests (NestJS workers are parallel).
 *   - It MUST return synchronously-then-stream: the returned promise
 *     resolves with the readable; chunks start flowing after.
 *   - It MUST NOT retain references to `data` after the stream ends
 *     (memory pressure on long-lived processes).
 */
export interface IPdfDocument {
  renderToStream(data: PdfDocumentData): Promise<Readable>;
}
