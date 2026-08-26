/**
 * PdfGenerationService — render orchestrator for `GET /sales/:id/pdf`
 * and `GET /quotations/:id/pdf` (WU4).
 *
 * Why this service exists:
 *   - Single seam between the HTTP layer (PdfGenerationController, WU4)
 *     and the React-PDF template registry (`templates/registry.ts`).
 *   - Owns three concerns that don't belong in the controller:
 *       1. Sale/Quotation fetch + tenant-isolation
 *          (`SalesService.getSaleDetail` / `QuotationsService.findOne`,
 *          tenant-scoped via CLS).
 *       2. Format validation + template selection
 *          (`getTemplate(format)` from the registry).
 *       3. Render invocation + exception mapping (renderer failures
 *          become 500, not 502).
 *
 * Why NOT register a custom font per-render?
 *   - `@react-pdf/renderer`'s `Font.register()` mutates a global
 *     registry; calling it per-request risks redundant work + thread-
 *     safety concerns under NestJS's parallel worker pool. We do it
 *     exactly once at boot via `OnModuleInit` (design: "Module-init
 *     font registration"). The font itself lives in `pdf-generation.
 *     constants.ts`.
 *
 * Error mapping (per design's threat matrix):
 *
 *   | Condition                               | Exception                          | HTTP |
 *   |-----------------------------------------|------------------------------------|------|
 *   | Sale not found / wrong tenant           | `NotFoundException`                | 404  |
 *   | Sale status !== 'CONFIRMED'             | `BadRequestException('SALE_NOT_CONFIRMED')` | 400  |
 *   | Quotation not found / wrong tenant      | `NotFoundException`                | 404  |
 *   | Renderer throws                         | `InternalServerErrorException('PDF_GENERATION_FAILED')` | 500  |
 *   | Invalid `format` param                  | `BadRequestException('INVALID_FORMAT')`     | 400  | (controller)
 *
 * WU4 addition: the `renderQuotationPdf` path renders a quotation in
 * any status (DRAFT previews are allowed by spec). There is no status
 * guard — the only failure path is `NotFoundException` (no quotation
 * in the tenant) or a renderer crash mapped to 500.
 */
import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  OnModuleInit,
} from '@nestjs/common';
import { createElement } from 'react';
import { Font, renderToStream } from '@react-pdf/renderer';
import type { Readable } from 'node:stream';
import { SalesService } from '../sales/sales.service';
import {
  COMPANY_NAME,
  DEFAULT_FORMAT_KEY,
  FormatKey,
  LOGO_URL,
  PDF_FONT_REGISTRY,
} from './pdf-generation.constants';
import { getTemplate } from './templates/registry';
import type { SaleDetailResponseDto } from '../sales/dto/sale-detail-response.dto';
import type { LineItem, Payment } from './templates/shared';
import { registerModernFont } from './templates/shared';
import type {
  ReceiptDocumentProps,
  ReceiptBusiness,
  ReceiptSale,
  ReceiptCustomer,
} from './templates/receipt/receipt.types';
import type {
  QuotationDocumentProps,
} from './templates/quotation/quotation-a4.document';
import type { QuotationResponseDto } from '../quotations/dto/quotation-response.dto';

const SUPPORTED_FORMATS: readonly FormatKey[] = [
  DEFAULT_FORMAT_KEY,
  'receipt-ticket',
  'quotation-a4',
] as const;

@Injectable()
export class PdfGenerationService implements OnModuleInit {
  private readonly logger = new Logger(PdfGenerationService.name);

  constructor(private readonly salesService: SalesService) {}

  /**
   * WU4 — Module-boot font registration.
   *
   * `@react-pdf/renderer`'s `Font.register()` mutates a process-wide
   * registry, so we call it exactly once per Node process. The
   * registry lives at `pdf-generation.constants.ts` so it can be
   * shared with future custom-font templates (invoice, quote).
   *
   * Defensive try/catch: a missing font file (broken CDN, network
   * unreachable, font removed by the host) MUST NOT take down the
   * whole API. We log a warning and fall back to the bundled
   * Helvetica — receipts will render with a substituted font instead
   * of a 5xx response.
   *
   * Hyphenation callback: Spanish fiscal receipts commonly break
   * long product names with hyphenation. The callback just returns
   * the input word unbroken (a no-op) — we don't need full Spanish
   * hyphenation rules, just the registration so future templates
   * can opt in.
   */
  async onModuleInit(): Promise<void> {
    try {
      Font.register(PDF_FONT_REGISTRY as Parameters<typeof Font.register>[0]);
      this.logger.log(
        `Custom font "${(PDF_FONT_REGISTRY as { family?: string }).family ?? 'unnamed'}" registered for PDF rendering.`,
      );
    } catch (err) {
      this.logger.warn(
        `Font.register failed at module init — falling back to bundled Helvetica. ` +
          `Error: ${(err as Error).message}`,
      );
    }

    try {
      Font.registerHyphenationCallback((word: string) => [word]);
    } catch (err) {
      // Some @react-pdf/font versions do not expose this API; log
      // and move on. Receipts render fine without hyphenation.
      this.logger.warn(
        `Font.registerHyphenationCallback failed: ${(err as Error).message}`,
      );
    }

    // PILOT — register the Inter family (static weights) for the modern
    // quotation template. `registerModernFont` pre-flights the font CDN
    // and resolves to Helvetica when unreachable, so a boot-time font
    // outage never hard-fails a quotation render (react-pdf 4.x throws
    // at render when a requested weight cannot be fetched). Awaited so
    // the first quotation render already binds to the resolved family.
    try {
      const family = await registerModernFont();
      this.logger.log(`Modern font resolved for PDF rendering: "${family}".`);
    } catch (err) {
      this.logger.warn(
        `Modern font registration failed — using Helvetica. ` +
          `Error: ${(err as Error).message}`,
      );
    }
  }

  /**
   * Validate the `format` query string and reject unknown values.
   *
   * Public so the controller can call it BEFORE the service round-
   * trips the database — surfaces 400 INVALID_FORMAT at the earliest
   * possible point in the pipeline.
   */
  validateFormat(format: unknown): asserts format is FormatKey {
    if (
      typeof format !== 'string' ||
      !SUPPORTED_FORMATS.includes(format as FormatKey)
    ) {
      throw new BadRequestException('INVALID_FORMAT');
    }
  }

  /**
   * Resolve the format key, defaulting to A4 when the caller passes
   * `undefined` or an empty string. Mirrors the spec's "A4 MUST be
   * the default when no `format` query param is provided" rule.
   */
  resolveFormat(format: string | undefined): FormatKey {
    const candidate = format && format.length > 0 ? format : DEFAULT_FORMAT_KEY;
    this.validateFormat(candidate);
    return candidate;
  }

  /**
   * Render a confirmed sale to a streamed PDF.
   *
   * Pipeline:
   *   1. `SalesService.getSaleDetail(saleId)` — tenant-scoped, also
   *      filters on `status: 'CONFIRMED'` (so DRAFT sales cannot
   *      reach this method via the real repo). Throws
   *      `NotFoundException` if the sale is missing or cross-tenant.
   *   2. Status guard — defensive check on `sale.status`. The real
   *      repo already filters CONFIRMED, but the contract must hold
   *      even if the upstream filter is ever loosened.
   *   3. Build `ReceiptDocumentProps` from the sale + tenant.
   *   4. `getTemplate(format)` picks the React component.
   *   5. `renderToStream(<Template {...props} />)` returns a Node
   *      `Readable` we hand back to the controller.
   *
   * Returns `{ stream, folio }` instead of just the stream so the
   * controller can put the human-readable folio in the
   * `Content-Disposition: attachment; filename="recibo-{folio}.pdf"`
   * header (spec mandate). The folio is fetched as part of
   * `getSaleDetail` — no extra DB roundtrip.
   *
   * Note: the second arg is `tenantId` (string) for future-proofing;
   * today the tenant context is already enforced by CLS through the
   * SalesService's repository. The arg is accepted (not used for
   * branching) so a future caller — say, a super-admin preview —
   * can pass an explicit tenant without changing the signature.
   */
  async generateSalePdf(
    saleId: string,
    _tenantId: string,
    format: FormatKey,
  ): Promise<{ stream: Readable; folio: string }> {
    let sale: SaleDetailResponseDto;
    try {
      sale = await this.salesService.getSaleDetail(saleId);
    } catch (err) {
      // Pass NestJS HTTP exceptions through untouched — the controller's
      // exception filter maps them to the right status code (404, 400).
      if (err instanceof NotFoundException) {
        throw err;
      }
      // Anything else (DB down, repository contract violation) bubbles
      // up as 500. We do NOT swallow it as 404 — that would hide infra
      // failures from the FE.
      throw err;
    }

    if (sale.status !== 'CONFIRMED') {
      throw new BadRequestException('SALE_NOT_CONFIRMED');
    }

    const props = this.buildReceiptProps(sale);

    const Template = getTemplate(format);

    let stream: Readable;
    try {
      stream = (await renderToStream(
        createElement(Template, props) as unknown as Parameters<
          typeof renderToStream
        >[0],
      )) as Readable;
    } catch (err) {
      this.logger.error(
        `PDF render failed for sale ${saleId} (format=${format}): ${(err as Error).message}`,
      );
      throw new InternalServerErrorException('PDF_GENERATION_FAILED');
    }

    return { stream, folio: sale.folio ?? saleId };
  }

  /**
   * Map the persisted `SaleDetailResponseDto` into the shape the
   * receipt templates expect. Kept private + side-effect-free so
   * the unit tests can pin the mapping without booting the renderer.
   */
  private buildReceiptProps(sale: SaleDetailResponseDto): ReceiptDocumentProps {
    const business: ReceiptBusiness = {
      companyName: COMPANY_NAME,
      logoUrl: LOGO_URL,
    };

    const saleMeta: ReceiptSale = {
      folio: sale.folio ?? '—',
      date: sale.confirmedAt ?? new Date().toISOString(),
      cashier: sale.cashier?.name ?? '—',
      seller: sale.seller?.name ?? '—',
    };

    const customer: ReceiptCustomer = {
      name: sale.customer?.name ?? null,
    };

    const items: LineItem[] = sale.items.map((item) => ({
      productName: item.productName,
      variantName: item.variantName,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      discountTitle: item.discountTitle,
      discountAmountCents: item.discountAmountCents,
      subtotalCents: item.subtotalCents,
    }));

    // Custom Payment Methods (custom-payment-methods / WU2 — D10):
    // pass through `paymentMethodName` / `paymentMethodSubtitle` from
    // the persisted snapshot so the receipt template can prefer the
    // branded label over the base-category fallback. Legacy rows
    // carry `null` here and the template falls back to `formatMethod`.
    const payments: Payment[] = sale.payments.map((payment) => ({
      method: payment.method,
      amountCents: payment.amountCents,
      reference: payment.reference,
      paidAt: payment.paidAt,
      paymentMethodName: payment.paymentMethodName ?? null,
      paymentMethodSubtitle: payment.paymentMethodSubtitle ?? null,
    }));

    return {
      business,
      sale: saleMeta,
      customer,
      items,
      totals: {
        subtotalCents: sale.subtotalCents,
        discountCents: sale.discountCents,
        totalCents: sale.totalCents,
        paidCents: sale.paidCents,
        debtCents: sale.debtCents,
        changeDueCents: sale.changeDueCents,
      },
      payments,
    };
  }

  /**
   * WU4 — Render a quotation PDF to a Node Readable stream.
   *
   * Accepts the wire-level `QuotationResponseDto` directly (rather
   * than re-fetching via `QuotationsService.findOne`) so this method
   * doesn't depend on `QuotationsService` — the controller fetches
   * the quotation first (404 path) then hands the DTO to this
   * service. This breaks the `QuotationsModule ↔ PdfGenerationModule`
   * DI cycle that would otherwise require `forwardRef`.
   *
   * Pipeline:
   *   1. Build `QuotationDocumentProps` from the wire shape.
   *   2. `getTemplate(format)` picks the React component. Currently
   *      only `quotation-a4` is registered for quotations — the
   *      controller's `validateFormat` already rejects unknown keys
   *      before this method runs.
   *   3. `renderToStream(<Template {...props} />)` returns a Node
   *      `Readable` we hand back to the controller.
   *
   * Returns `{ stream, folio }` (folio = the quotation id) so the
   * controller can stamp it into the `Content-Disposition` filename
   * (`cotizacion-{id}.pdf`).
   *
   * **No status guard** — quotations are renderable in any status
   * per the spec scenario "PDF preview DRAFT/SENT/EXPIRED".
   */
  async renderQuotationPdf(
    quotation: QuotationResponseDto,
    format: FormatKey,
  ): Promise<{ stream: Readable; folio: string }> {
    const props = this.buildQuotationProps(quotation);
    const Template = getTemplate(format);

    let stream: Readable;
    try {
      stream = (await renderToStream(
        createElement(Template, props) as unknown as Parameters<
          typeof renderToStream
        >[0],
      )) as Readable;
    } catch (err) {
      this.logger.error(
        `PDF render failed for quotation ${quotation.id} (format=${format}): ${(err as Error).message}`,
      );
      throw new InternalServerErrorException('PDF_GENERATION_FAILED');
    }

    return { stream, folio: quotation.id };
  }

  /**
   * WU4 — Render a quotation PDF to an in-memory `Buffer`. Used by the
   * `send()` atomic flow inside `QuotationsService` to attach the PDF
   * to a Resend email without going through the HTTP boundary.
   *
   * Accepts the wire-level `QuotationResponseDto` directly (rather
   * than re-fetching via `QuotationsService.findOne`) so this method
   * doesn't depend on `QuotationsService` — the send flow already
   * has the entity in hand and would otherwise pay a redundant
   * DB roundtrip. This also avoids a `QuotationsModule ↔
   * PdfGenerationModule` DI cycle: `QuotationsModule` consumes this
   * service directly, no back-reference needed.
   *
   * Returns the raw bytes so the caller can hand them to
   * `mailer.send({ attachments: [{ content, filename }] })` (Resend
   * accepts base64 strings; we convert via `Buffer.toString('base64')`
   * in the service to keep this seam narrow).
   *
   * Same error mapping as `renderQuotationPdf` — renderer crash →
   * 500. The send flow catches the 500 and rolls back the SENT
   * transition (status stays DRAFT).
   */
  async renderQuotationPdfToBuffer(
    quotation: QuotationResponseDto,
    format: FormatKey,
  ): Promise<Buffer> {
    const props = this.buildQuotationProps(quotation);
    const Template = getTemplate(format);

    try {
      // Lazy import to avoid pulling `@react-pdf/renderer` into the
      // bundle during cold module init when `renderToStream` is the
      // only path. Both calls (`renderToStream` and `renderToBuffer`)
      // share the same Yoga WASM instance — keeping them co-located
      // here matches the receipt pipeline.
      const { renderToBuffer } = await import('@react-pdf/renderer');
      return await renderToBuffer(
        createElement(Template, props) as unknown as Parameters<
          typeof renderToBuffer
        >[0],
      );
    } catch (err) {
      this.logger.error(
        `PDF buffer render failed for quotation ${quotation.id} (format=${format}): ${(err as Error).message}`,
      );
      throw new InternalServerErrorException('PDF_GENERATION_FAILED');
    }
  }

  /**
   * Map the persisted `QuotationResponseDto` into the shape the
   * quotation template expects. Side-effect-free so the unit tests
   * can pin the mapping without booting the renderer.
   */
  private buildQuotationProps(
    quotation: QuotationResponseDto,
  ): QuotationDocumentProps {
    const items: LineItem[] = quotation.items.map((item) => ({
      productName: item.productName,
      variantName: item.variantName,
      quantity: item.quantity,
      unitPriceCents: item.unitPriceCents,
      discountTitle: item.discountTitle ?? null,
      discountAmountCents: item.discountAmountCents ?? null,
      subtotalCents: item.subtotalCents,
    }));

    return {
      business: {
        companyName: COMPANY_NAME,
        logoUrl: LOGO_URL,
      },
      quotation: {
        id: quotation.id,
        date:
          quotation.createdAt instanceof Date
            ? quotation.createdAt.toISOString()
            : new Date(quotation.createdAt).toISOString(),
        expiresAt: quotation.expiresAt
          ? quotation.expiresAt instanceof Date
            ? quotation.expiresAt.toISOString()
            : new Date(quotation.expiresAt).toISOString()
          : null,
      },
      customer: {
        name: quotation.customer
          ? [quotation.customer.firstName, quotation.customer.lastName]
              .filter(Boolean)
              .join(' ')
              .trim() || null
          : null,
        email: quotation.customer?.email ?? null,
      },
      // The seller display name rides on `seller.name` when present; the
      // send-flow wire DTO (built in `QuotationsService.send` from the
      // entity directly) does NOT carry the `seller` snapshot, so we fall
      // back to the raw `sellerUserId` — never render an empty Vendedor row.
      seller: {
        name: quotation.seller?.name ?? quotation.sellerUserId,
      },
      items,
      totals: {
        subtotalCents: quotation.subtotalCents,
        discountCents: quotation.discountCents,
        totalCents: quotation.totalCents,
      },
    };
  }
}
