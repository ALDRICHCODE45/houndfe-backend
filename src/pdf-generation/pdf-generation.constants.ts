/**
 * PdfGeneration constants — branding, paper sizes, format keys, tokens.
 *
 * WU1 is foundation-only: we declare the *shape* of everything that
 * later work units will consume. Templates (WU2/WU3), service (WU4),
 * and integration (WU5) all read from this file, so they all stay
 * in sync without cross-imports.
 *
 * Sourcing rules (per design):
 *   - `COMPANY_NAME` + `LOGO_URL` are hardcoded at company level.
 *     Branch-specific branding (logo per tenant) is a future SDD; for
 *     now every branch renders the same brand block.
 *   - `LOGO_URL` matches the existing email-template pattern
 *     (`houndfe.sfo3.cdn.digitaloceanspaces.com/brand/`) so the same
 *     asset serves both email and PDF — single source of truth in
 *     the Spaces bucket, no duplicate upload.
 *   - Branch `address` / `phone` come from the Tenant model per
 *     request; those live on the `tenant` arg passed to templates,
 *     not here.
 */

/**
 * Paper dimensions in PDF points (1pt = 1/72 inch).
 *
 * Sourced from `@react-pdf/renderer` PaperSize:
 *   - A4 = 595.28 × 841.89 pt (rounded to 595 × 842)
 *   - Ticket (80mm thermal) = 227 pt wide, variable height
 *
 * `Variable` (vs `Number`) signals to template code that the Page
 * height is computed at render time from content length. We keep
 * `ticketWidthPt` as the only fixed dimension for the ticket format.
 */
export const PAPER_SIZES = {
  A4: {
    width: 595,
    height: 842,
  },
  TICKET: {
    width: 227,
    height: 'Variable' as const,
  },
} as const;

/**
 * Format keys accepted by `GET /sales/:id/pdf?format=<key>`.
 *
 * `receipt-a4` is the default (per spec — "A4 MUST be the default when
 * no `format` query param is provided"). New formats (invoice-a4,
 * report-a4, quote-a4) extend this union in WU3+.
 */
export const DEFAULT_FORMAT_KEY = 'receipt-a4' as const;

export type FormatKey =
  | typeof DEFAULT_FORMAT_KEY
  | 'receipt-ticket';

/**
 * Branding defaults — same houndfe-logo asset used by the email
 * templates (`low-stock.email.tsx`, `time-off-request.email.tsx`).
 * PDF must degrade gracefully if the logo fails to load (spec:
 * "header shows company name as text only"), so templates wrap
 * the `<Image src={LOGO_URL} />` in a try-render fallback.
 */
export const COMPANY_NAME = 'HoundFe' as const;

export const LOGO_URL =
  'https://houndfe.sfo3.cdn.digitaloceanspaces.com/brand/houndfe-logo-email.png';

/**
 * Module injection tokens.
 *
 * Pattern matches the codebase: `Symbol.for('Name')` for tokens that
 * span modules or persist across test boots, plain `Symbol('Name')`
 * for internal-only tokens. We start with the service + module-level
 * tokens we'll need by WU4 — declaring them here means feature work
 * (font registration, render orchestration) can inject by symbol
 * without retrofitting constants files later.
 */

/** DI token for the module's render service (consumed by the controller in WU4). */
export const PDF_GENERATION_SERVICE = Symbol.for('PdfGenerationService');

/**
 * WU4 — Font registration payload for `Font.register()`.
 *
 * Typed as the structural subset of `@react-pdf/font`'s `SingleLoad`
 * shape: `{ family, src, fontStyle?, fontWeight? }`. We keep this
 * constant in plain JSON-ish form (instead of importing the
 * @react-pdf types at the constants layer) so:
 *   - The constants module stays dependency-light.
 *   - The font can be swapped (CDN URL, base64, or self-hosted) by
 *     editing one constant.
 *
 * Font choice rationale: Roboto is the same family used by the
 * existing email templates (`low-stock.email.tsx`,
 * `time-off-request.email.tsx`); reusing it keeps brand type
 * consistent across email + PDF. The CDN path matches the email
 * pattern; if the asset is ever removed, the `OnModuleInit`
 * defensive try/catch in `PdfGenerationService` logs a warning and
 * falls back to bundled Helvetica so receipts still render.
 *
 * NOTE: only consumed by `PdfGenerationService.onModuleInit` — the
 * `Symbol.for(...)` token name is historical and reserved for future
 * DI overrides (e.g. injecting a different font bundle in tests).
 */
export const PDF_FONT_REGISTRY = {
  family: 'Roboto',
  src: 'https://fonts.gstatic.com/s/roboto/v30/KFOmCnqEu92Fr1Mu4mxKKTU1Kg.woff',
  fontStyle: 'normal' as const,
  fontWeight: 'normal' as const,
} as const;
