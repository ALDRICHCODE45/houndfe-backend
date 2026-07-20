/**
 * PdfGenerationController — HTTP endpoint tests (WU4 + WU5 polish).
 *
 * What we verify:
 *   - `GET /sales/:id/pdf` with no format defaults to A4.
 *   - `GET /sales/:id/pdf?format=receipt-ticket` switches templates.
 *   - Invalid format → 400 INVALID_FORMAT.
 *   - Service throws NotFoundException → controller surfaces 404.
 *   - Service throws BadRequestException (DRAFT sale) → 400.
 *   - Response headers carry `Content-Type: application/pdf` and
 *     `Content-Disposition: attachment; filename="recibo-{folio}.pdf"`.
 *     WU5 polish: filename uses the human-readable folio returned
 *     by the service, not the URL id.
 *
 * Mocking strategy:
 *   - We instantiate the controller directly with a mock service.
 *     Guards (`JwtAuthGuard`, `TenantContextGuard`, `PermissionsGuard`)
 *     are applied via decorators on the class; they're not exercised
 *     here — those are tested by the integration suite (WU5) and the
 *     guard unit specs. This mirrors the sales controller spec
 *     pattern (`src/sales/sales.controller.spec.ts`).
 */
import { Readable } from 'node:stream';
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { Response } from 'express';
import { PdfGenerationController } from './pdf-generation.controller';
import { PdfGenerationService } from './pdf-generation.service';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';

// ── Mocks ──────────────────────────────────────────────────────────────

function makeMockPdfService() {
  return {
    generateSalePdf: jest.fn(),
    validateFormat: jest.fn(),
    resolveFormat: jest.fn(),
  };
}

function makeMockUser(tenantId = 'tenant-1'): AuthenticatedUser {
  return {
    userId: 'user-1',
    email: 'user@test.com',
    tenantId,
    tenantSlug: 'test',
    isSuperAdmin: false,
  };
}

function makeMockRes(): Response {
  // WU5 — controller uses `stream.pipe(res)` instead of
  // `res.send(stream)` because Express's res.send JSON-serializes
  // Readable streams on @nestjs/platform-express@11.x. The real
  // Node `Readable.pipe()` calls `dest.on('drain')` /
  // `dest.on('close')` / `dest.on('finish')` AND `dest.destroy()`
  // internally, so we don't try to mock `res` deep enough to make a
  // real pipe work — instead, we spy on `Readable.prototype.pipe`
  // and stub the call. The mock `res` only needs `set` for the
  // header assertion; pipe itself is observed via the spy.
  const res: Partial<Response> = {
    set: jest.fn().mockReturnThis(),
  };
  return res as Response;
}

// Spy on Readable.prototype.pipe so the controller's stream-pipe
// doesn't actually try to write to a mock res. We restore after
// every test in `afterEach` below.
let pipeSpy: jest.SpyInstance | undefined;
beforeEach(() => {
  pipeSpy = jest
    .spyOn(Readable.prototype, 'pipe')
    .mockReturnThis();
});
afterEach(() => {
  pipeSpy?.mockRestore();
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('PdfGenerationController', () => {
  let controller: PdfGenerationController;
  let service: ReturnType<typeof makeMockPdfService>;

  beforeEach(() => {
    service = makeMockPdfService();
    controller = new PdfGenerationController(
      service as unknown as PdfGenerationService,
    );
    jest.clearAllMocks();
  });

  describe('GET /sales/:id/pdf', () => {
    it('defaults to A4 format when no format query param is supplied', async () => {
      const stream = Readable.from([Buffer.from('%PDF-1.4 fake')]);
      service.resolveFormat.mockReturnValue('receipt-a4');
      service.generateSalePdf.mockResolvedValue({ stream, folio: 'A-0001' });

      const user = makeMockUser();
      const res = makeMockRes();

      await controller.generatePdf('sale-1', undefined, user, res);

      expect(service.resolveFormat).toHaveBeenCalledWith(undefined);
      expect(service.generateSalePdf).toHaveBeenCalledWith(
        'sale-1',
        'tenant-1',
        'receipt-a4',
      );
    });

    it('uses the ticket template when format=receipt-ticket', async () => {
      const stream = Readable.from([Buffer.from('%PDF-1.4 ticket')]);
      service.resolveFormat.mockReturnValue('receipt-ticket');
      service.generateSalePdf.mockResolvedValue({ stream, folio: 'A-0001' });

      const user = makeMockUser();
      const res = makeMockRes();

      await controller.generatePdf('sale-1', 'receipt-ticket', user, res);

      expect(service.resolveFormat).toHaveBeenCalledWith('receipt-ticket');
      expect(service.generateSalePdf).toHaveBeenCalledWith(
        'sale-1',
        'tenant-1',
        'receipt-ticket',
      );
    });

    it('sets Content-Type and Content-Disposition headers on the response', async () => {
      const stream = Readable.from([Buffer.from('%PDF-1.4 fake')]);
      service.resolveFormat.mockReturnValue('receipt-a4');
      service.generateSalePdf.mockResolvedValue({ stream, folio: 'A-0001' });

      const user = makeMockUser();
      const res = makeMockRes();

      await controller.generatePdf('sale-1', undefined, user, res);

      expect(res.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Type': 'application/pdf',
          'Content-Disposition': expect.stringMatching(
            /^attachment; filename="recibo-.+\.pdf"$/,
          ),
        }),
      );
      expect(pipeSpy).toHaveBeenCalledWith(res);
    });

    it('uses the folio (not the URL id) for the Content-Disposition filename', async () => {
      // WU5 polish — the spec mandates `recibo-{folio}.pdf`. The
      // service returns the folio; the controller stamps it into the
      // header. We pass a URL id that intentionally differs from the
      // folio to prove the header reads from the folio, not the id.
      const stream = Readable.from([Buffer.from('%PDF-1.4 fake')]);
      service.resolveFormat.mockReturnValue('receipt-a4');
      service.generateSalePdf.mockResolvedValue({ stream, folio: 'B-0042' });

      const user = makeMockUser();
      const res = makeMockRes();

      await controller.generatePdf('00000000-0000-4000-8000-000000000001', undefined, user, res);

      expect(res.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Disposition': 'attachment; filename="recibo-B-0042.pdf"',
        }),
      );
    });

    it('sanitizes unsafe characters out of the folio for the filename', async () => {
      // Defensive — a folio with `/` (legacy import) must not produce
      // a path-traversal filename. The regex strips everything that
      // isn't alnum or hyphen.
      const stream = Readable.from([Buffer.from('%PDF-1.4 fake')]);
      service.resolveFormat.mockReturnValue('receipt-a4');
      service.generateSalePdf.mockResolvedValue({
        stream,
        folio: 'B/0042*?<>',
      });

      const user = makeMockUser();
      const res = makeMockRes();

      await controller.generatePdf('sale-1', undefined, user, res);

      expect(res.set).toHaveBeenCalledWith(
        expect.objectContaining({
          'Content-Disposition': 'attachment; filename="recibo-B0042.pdf"',
        }),
      );
    });

    it('passes through 404 NotFoundException from the service', async () => {
      service.resolveFormat.mockReturnValue('receipt-a4');
      service.generateSalePdf.mockRejectedValue(
        new NotFoundException('Sale not found'),
      );

      const user = makeMockUser();
      const res = makeMockRes();

      await expect(
        controller.generatePdf('sale-99', undefined, user, res),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(pipeSpy).not.toHaveBeenCalled();
    });

    it('passes through 400 BadRequestException (SALE_NOT_CONFIRMED) from the service', async () => {
      service.resolveFormat.mockReturnValue('receipt-a4');
      service.generateSalePdf.mockRejectedValue(
        new BadRequestException('SALE_NOT_CONFIRMED'),
      );

      const user = makeMockUser();
      const res = makeMockRes();

      await expect(
        controller.generatePdf('sale-1', undefined, user, res),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(pipeSpy).not.toHaveBeenCalled();
    });

    it('passes through 500 InternalServerErrorException (PDF_GENERATION_FAILED) from the service', async () => {
      service.resolveFormat.mockReturnValue('receipt-a4');
      service.generateSalePdf.mockRejectedValue(
        new InternalServerErrorException('PDF_GENERATION_FAILED'),
      );

      const user = makeMockUser();
      const res = makeMockRes();

      await expect(
        controller.generatePdf('sale-1', undefined, user, res),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('returns 400 INVALID_FORMAT when resolveFormat throws BadRequestException', async () => {
      service.resolveFormat.mockImplementation(() => {
        throw new BadRequestException('INVALID_FORMAT');
      });

      const user = makeMockUser();
      const res = makeMockRes();

      // First call: rejected with BadRequestException('INVALID_FORMAT').
      let caught: unknown;
      try {
        await controller.generatePdf('sale-1', 'pdf-bogus', user, res);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(BadRequestException);
      expect((caught as BadRequestException).message).toBe('INVALID_FORMAT');

      // Service was never reached — format validation short-circuits.
      expect(service.generateSalePdf).not.toHaveBeenCalled();
    });

    it('extracts tenantId from the authenticated user', async () => {
      const stream = Readable.from([Buffer.from('%PDF-1.4 fake')]);
      service.resolveFormat.mockReturnValue('receipt-a4');
      service.generateSalePdf.mockResolvedValue({ stream, folio: 'A-0001' });

      const user = makeMockUser('tenant-42');
      const res = makeMockRes();

      await controller.generatePdf('sale-1', undefined, user, res);

      expect(service.generateSalePdf).toHaveBeenCalledWith(
        'sale-1',
        'tenant-42',
        'receipt-a4',
      );
    });
  });
});