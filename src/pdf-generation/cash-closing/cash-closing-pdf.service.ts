/**
 * cash-register-closing / T5 (S3,S7) — render orchestrator for the closing PDF.
 *
 * Why this service exists (and what it deliberately does NOT do):
 *   - It is the ONLY seam between the HTTP layer and the template. It fetches
 *     the cut through the injected `CASH_APPLICATION` port with
 *     `{ kind: 'CLOSING', id }` and renders that frozen payload.
 *   - It NEVER queries the database or the sales application live. There is
 *     no sales provider, no repository and no live catalog read — a later
 *     payment, rename or cancellation cannot leak into the receipt (S7).
 *   - The actor (userId + CASL ability) is forwarded to the port so the
 *     application rechecks tenant/instance scope; a denied query rejects and
 *     this service passes the HTTP exception through untouched.
 *   - A malformed payload fails CLOSED with 500
 *     `CASH_CLOSING_SNAPSHOT_INVALID` — we never render a guessed or
 *     zero-filled cut.
 *
 * Buffer pattern: mirrors `PdfGenerationService.renderSellerSalesReportPdf`
 * (lazy `renderToBuffer` import sharing the renderer/Yoga instance), so the
 * controller can set headers and `res.send(buffer)`.
 */
import {
  Inject,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { createElement } from 'react';
import {
  CASH_APPLICATION,
  type CashActor,
  type ICashApplication,
} from '../../cash-register/cash-application.port';
import { CashClosingA4Document } from './cash-closing-a4.document';
import {
  CASH_CLOSING_SNAPSHOT_INVALID,
  CashClosingSnapshotParseError,
  parseCashClosingReceipt,
} from './cash-closing-receipt.parser';
import type { CashClosingReceipt } from './cash-closing-receipt.types';

export interface CashClosingPdfResult {
  readonly buffer: Buffer;
  readonly folio: string;
}

@Injectable()
export class CashClosingPdfService {
  private readonly logger = new Logger(CashClosingPdfService.name);

  constructor(
    @Inject(CASH_APPLICATION)
    private readonly cashApplication: ICashApplication,
  ) {}

  /**
   * Fetch the frozen closing via the application port and render it to a PDF
   * buffer. The port owns tenant/instance authorization; its HTTP exceptions
   * (404/403) bubble up unchanged.
   */
  async generateClosingReceipt(
    actor: CashActor,
    closingId: string,
  ): Promise<CashClosingPdfResult> {
    const document = await this.cashApplication.query(actor, {
      kind: 'CLOSING',
      id: closingId,
    });

    let receipt: CashClosingReceipt;
    try {
      receipt = parseCashClosingReceipt(document);
    } catch (err) {
      if (err instanceof CashClosingSnapshotParseError) {
        this.logger.error(
          `Cash closing ${closingId} has an untrusted snapshot (${err.field}); refusing to render.`,
        );
        throw new InternalServerErrorException(CASH_CLOSING_SNAPSHOT_INVALID);
      }
      throw err;
    }

    const buffer = await this.renderClosingReceipt(receipt);
    return { buffer, folio: receipt.folio };
  }

  /**
   * Render one validated receipt to a Buffer. Lazy renderer import so this
   * path shares the process-wide `@react-pdf/renderer`/Yoga instance.
   */
  async renderClosingReceipt(receipt: CashClosingReceipt): Promise<Buffer> {
    try {
      const { renderToBuffer } = await import('@react-pdf/renderer');
      // SAFETY: `createElement` builds the element at runtime; the renderer's
      // public signature names its own element type, so only the nominal
      // static type differs (same pattern as the receipt/report paths).
      return await renderToBuffer(
        createElement(CashClosingA4Document, {
          receipt,
        }) as unknown as Parameters<typeof renderToBuffer>[0],
      );
    } catch (err) {
      this.logger.error(
        `PDF buffer render failed for cash closing ${receipt.id}: ${(err as Error).message}`,
      );
      throw new InternalServerErrorException('PDF_GENERATION_FAILED');
    }
  }
}
