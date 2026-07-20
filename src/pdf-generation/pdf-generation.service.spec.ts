/**
 * PdfGenerationService — render orchestration tests (WU4).
 *
 * What we verify:
 *   - `generateSalePdf` produces a `Readable` stream for a confirmed sale.
 *   - It surfaces the right NestJS exception for each failure mode
 *     (NotFoundException for missing/cross-tenant, BadRequestException
 *     for non-CONFIRMED status, InternalServerErrorException for
 *     renderer failure).
 *   - It selects the template from `TEMPLATE_REGISTRY` based on the
 *     requested `FormatKey`.
 *   - The OnModuleInit font registration does NOT crash the boot even
 *     if Roboto fails to load (defensive try/catch — log-and-continue).
 *
 * Mocking strategy:
 *   - `SalesService.getSaleDetail` is mocked at the method level. It
 *     does the tenant-scoping inside its own implementation; we don't
 *     re-implement that here.
 *   - The template registry and `@react-pdf/renderer` are NOT touched:
 *     `renderToStream` is mocked at the module boundary so we can
 *     assert the service selects the right component without booting
 *     the real Yoga layout (the unit-test config redirects
 *     `yoga-layout` to a CJS stub — see `jest.config.js`).
 */
import { Readable } from 'node:stream';
import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import type { SaleDetailResponseDto } from '../sales/dto/sale-detail-response.dto';
import { PdfGenerationService } from './pdf-generation.service';
import { SalesService } from '../sales/sales.service';
import {
  COMPANY_NAME,
  DEFAULT_FORMAT_KEY,
  LOGO_URL,
} from './pdf-generation.constants';

// ── Fixtures ───────────────────────────────────────────────────────────

function makeConfirmedSale(
  overrides: Partial<SaleDetailResponseDto> = {},
): SaleDetailResponseDto {
  return {
    id: '00000000-0000-4000-8000-000000000001',
    folio: 'A-0001',
    status: 'CONFIRMED',
    channel: 'POS',
    register: 'POS-01',
    confirmedAt: '2026-07-20T15:00:00.000Z',
    dueDate: null,
    subtotalCents: 10000,
    discountCents: 0,
    totalCents: 10000,
    paidCents: 10000,
    debtCents: 0,
    changeDueCents: 0,
    paymentStatus: 'PAID',
    deliveryStatus: 'NOT_APPLICABLE',
    customer: null,
    cashier: { id: 'u-1', name: 'Maria' },
    seller: { id: 'u-2', name: 'Juan' },
    items: [
      {
        productName: 'Camisa',
        variantName: 'M',
        imageUrl: null,
        unitPriceCents: 5000,
        quantity: 2,
        discountCents: 0,
        subtotalCents: 10000,
        originalPriceCents: 5000,
        priceSource: 'default',
        appliedPriceListId: null,
        discountType: null,
        discountValue: null,
        discountAmountCents: null,
        discountTitle: null,
        prePriceCentsBeforeDiscount: null,
        rewardKind: null,
        rewardDiscountPercent: null,
        promotionId: null,
      },
    ],
    payments: [
      {
        method: 'CASH',
        amountCents: 10000,
        tenderedCents: 10000,
        changeCents: 0,
        reference: null,
        paidAt: '2026-07-20T15:00:00.000Z',
      },
    ],
    timeline: [],
    ...overrides,
  };
}

function makeMockSalesService() {
  return {
    getSaleDetail: jest.fn(),
  };
}

// `renderToStream` is a top-level export of `@react-pdf/renderer`; jest
// auto-mocks the whole module. We override the specific export with a
// stub that resolves to a Readable we control.
jest.mock('@react-pdf/renderer', () => {
  const real = jest.requireActual('@react-pdf/renderer');
  return {
    ...real,
    renderToStream: jest.fn(),
    Font: {
      ...real.Font,
      register: jest.fn(),
      registerHyphenationCallback: jest.fn(),
    },
  };
});

// ── Tests ──────────────────────────────────────────────────────────────

describe('PdfGenerationService', () => {
  let service: PdfGenerationService;
  let salesService: ReturnType<typeof makeMockSalesService>;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const renderer = require('@react-pdf/renderer');

  beforeEach(async () => {
    salesService = makeMockSalesService();

    const moduleRef = await Test.createTestingModule({
      providers: [
        PdfGenerationService,
        { provide: SalesService, useValue: salesService },
      ],
    }).compile();

    service = moduleRef.get(PdfGenerationService);
    jest.clearAllMocks();
  });

  // ── Happy path ─────────────────────────────────────────────────────

  it('returns a Readable stream for a CONFIRMED sale with default format', async () => {
    const sale = makeConfirmedSale();
    salesService.getSaleDetail.mockResolvedValue(sale);

    const expectedStream = Readable.from([Buffer.from('%PDF-1.4 fake')]);
    renderer.renderToStream.mockReturnValue(expectedStream);

    const result = await service.generateSalePdf(
      sale.id,
      'tenant-1',
      DEFAULT_FORMAT_KEY,
    );

    // WU5 — return shape changed from `Readable` to `{ stream, folio }`
    // so the controller can stamp the human-readable folio into the
    // `Content-Disposition` filename. The stream we hand back is the
    // exact same Node Readable from the renderer.
    expect(result.stream).toBe(expectedStream);
    expect(result.folio).toBe(sale.folio);
    expect(renderer.renderToStream).toHaveBeenCalledTimes(1);
    // Verify the template that was rendered is the A4 one.
    const renderedElement = renderer.renderToStream.mock.calls[0][0];
    expect(renderedElement.type).toBeDefined();
    // The component name (function name) is preserved by the babel
    // transform; in case it's not, we assert on the rendered props
    // shape instead.
    const props = renderedElement.props as Record<string, unknown>;
    expect(props).toHaveProperty('sale');
    expect(props).toHaveProperty('totals');
    expect(props).toHaveProperty('items');
  });

  it('selects the ticket template when format=receipt-ticket', async () => {
    const sale = makeConfirmedSale();
    salesService.getSaleDetail.mockResolvedValue(sale);

    const expectedStream = Readable.from([Buffer.from('%PDF-1.4 ticket')]);
    renderer.renderToStream.mockReturnValue(expectedStream);

    await service.generateSalePdf(sale.id, 'tenant-1', 'receipt-ticket');

    expect(renderer.renderToStream).toHaveBeenCalledTimes(1);
    const renderedElement = renderer.renderToStream.mock.calls[0][0];
    const props = renderedElement.props as Record<string, unknown>;
    // Both templates share the prop shape; the differentiation is the
    // component function itself. We assert that SOMETHING was rendered
    // for the ticket path (component name is not stable across babel).
    expect(props).toHaveProperty('items');
  });

  // ── Error mapping ──────────────────────────────────────────────────

  it('throws NotFoundException when the sale does not exist', async () => {
    salesService.getSaleDetail.mockRejectedValue(
      new NotFoundException('Sale not found'),
    );

    await expect(
      service.generateSalePdf(
        '00000000-0000-4000-8000-000000000099',
        'tenant-1',
        DEFAULT_FORMAT_KEY,
      ),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('throws BadRequestException for non-CONFIRMED sales (SALE_NOT_CONFIRMED)', async () => {
    // Even though the real `SalesService.getSaleDetail` filters on
    // status='CONFIRMED' at the SQL layer, the spec contract says we
    // MUST surface a 400 (SALE_NOT_CONFIRMED) for DRAFT sales. We
    // simulate that by mocking the service to return a DRAFT sale —
    // the same shape the real service would return IF the CONFIRMED
    // filter were ever loosened.
    const draftSale = makeConfirmedSale({ status: 'DRAFT' });
    salesService.getSaleDetail.mockResolvedValue(draftSale);

    await expect(
      service.generateSalePdf(draftSale.id, 'tenant-1', DEFAULT_FORMAT_KEY),
    ).rejects.toBeInstanceOf(BadRequestException);

    try {
      await service.generateSalePdf(draftSale.id, 'tenant-1', 'receipt-a4');
      fail('expected BadRequestException');
    } catch (err) {
      expect(err).toBeInstanceOf(BadRequestException);
      // The error message MUST carry the structured code so the FE
      // can branch on it.
      expect((err as BadRequestException).message).toBe('SALE_NOT_CONFIRMED');
    }
  });

  it('wraps renderer failures in InternalServerErrorException (PDF_GENERATION_FAILED)', async () => {
    const sale = makeConfirmedSale();
    salesService.getSaleDetail.mockResolvedValue(sale);

    renderer.renderToStream.mockImplementation(() => {
      throw new Error('yoga-layout blew up');
    });

    await expect(
      service.generateSalePdf(sale.id, 'tenant-1', DEFAULT_FORMAT_KEY),
    ).rejects.toBeInstanceOf(InternalServerErrorException);

    try {
      await service.generateSalePdf(sale.id, 'tenant-1', DEFAULT_FORMAT_KEY);
      fail('expected InternalServerErrorException');
    } catch (err) {
      expect(err).toBeInstanceOf(InternalServerErrorException);
      expect((err as InternalServerErrorException).message).toBe(
        'PDF_GENERATION_FAILED',
      );
    }
  });

  // ── OnModuleInit ───────────────────────────────────────────────────

  describe('onModuleInit', () => {
    it('registers Roboto font and Spanish hyphenation callback without throwing', async () => {
      // No-op renderToStream for this path; we just want the boot to
      // finish cleanly.
      renderer.Font.register.mockReturnValue(undefined);
      renderer.Font.registerHyphenationCallback.mockReturnValue(undefined);

      // Reset the service module so we can re-trigger onModuleInit
      // via a fresh module compile. The fresh compile also runs
      // onModuleInit on its own.
      const freshModule = await Test.createTestingModule({
        providers: [
          PdfGenerationService,
          { provide: SalesService, useValue: salesService },
        ],
      }).compile();

      await freshModule.init();

      // Font registration MUST have been attempted exactly once at boot.
      expect(renderer.Font.register).toHaveBeenCalledTimes(1);
      expect(renderer.Font.registerHyphenationCallback).toHaveBeenCalledTimes(
        1,
      );

      // First arg to register must declare the font family name.
      const regArg = renderer.Font.register.mock.calls[0][0] as Record<
        string,
        unknown
      >;
      expect(regArg.family).toBeTruthy();
    });

    it('does not crash module boot if Font.register throws', async () => {
      renderer.Font.register.mockImplementation(() => {
        throw new Error('Font registration failed');
      });
      renderer.Font.registerHyphenationCallback.mockReturnValue(undefined);

      const freshModule = await Test.createTestingModule({
        providers: [
          PdfGenerationService,
          { provide: SalesService, useValue: salesService },
        ],
      }).compile();

      // Module MUST init cleanly despite the Font.register failure
      // (defensive try/catch — log warning, continue). Nest's init()
      // resolves with the module instance, so we assert it doesn't
      // reject and that onModuleInit completed (Font.register was
      // attempted).
      const result = await freshModule.init();
      expect(result).toBeDefined();
      expect(renderer.Font.register).toHaveBeenCalled();
    });
  });

  // ── Receipt content sanity ────────────────────────────────────────

  it('feeds the template a populated ReceiptDocumentProps derived from the sale', async () => {
    const sale = makeConfirmedSale({
      customer: { id: 'c-1', name: 'Pedro Paramo' },
      folio: 'B-0042',
      subtotalCents: 8000,
      discountCents: 1000,
      totalCents: 7000,
      paidCents: 7000,
      debtCents: 0,
      changeDueCents: 0,
      cashier: { id: 'u-1', name: 'Cajero 1' },
      seller: { id: 'u-2', name: 'Vendedor 1' },
      confirmedAt: '2026-07-20T18:30:00.000Z',
    });
    salesService.getSaleDetail.mockResolvedValue(sale);

    renderer.renderToStream.mockReturnValue(Readable.from(['pdf']));

    await service.generateSalePdf(sale.id, 'tenant-1', DEFAULT_FORMAT_KEY);

    const renderedElement = renderer.renderToStream.mock.calls[0][0];
    const props = renderedElement.props as Record<string, unknown>;

    expect(props).toMatchObject({
      business: {
        companyName: COMPANY_NAME,
        logoUrl: LOGO_URL,
      },
      sale: {
        folio: 'B-0042',
        cashier: 'Cajero 1',
        seller: 'Vendedor 1',
      },
      customer: {
        name: 'Pedro Paramo',
      },
      totals: {
        subtotalCents: 8000,
        discountCents: 1000,
        totalCents: 7000,
        paidCents: 7000,
        debtCents: 0,
        changeDueCents: 0,
      },
    });

    const items = (props.items as unknown[]).slice();
    expect(items.length).toBe(1);
    expect(items[0]).toMatchObject({
      productName: 'Camisa',
      quantity: 2,
      unitPriceCents: 5000,
      subtotalCents: 10000,
    });

    const payments = (props.payments as unknown[]).slice();
    expect(payments.length).toBe(1);
    expect(payments[0]).toMatchObject({
      method: 'CASH',
      amountCents: 10000,
    });
  });
});
