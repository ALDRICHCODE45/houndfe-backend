/**
 * sales-history-redesign S11 — `GET /customers/:customerId/statement/pdf`
 * controller, after customers-bulk-actions / T3 extracted the shared
 * "render statement PDF for customer" path (`renderCustomerStatementPdfFor`)
 * that the bulk statements ZIP reuses. Behavior unchanged.
 */
import 'reflect-metadata';
import { PERMISSIONS_KEY } from '../auth/authorization/decorators/require-permissions.decorator';
import type { PdfGenerationService } from '../pdf-generation/pdf-generation.service';
import type { CustomerStatementService } from './customer-statement.service';
import type { CustomerStatementDto } from './dto/customer-statement.dto';
import {
  buildCustomerStatementPdfFilename,
  renderCustomerStatementPdfFor,
  SalesCustomerStatementController,
} from './sales-customer-statement.controller';

const CUSTOMER = '3f2a9c1e-0000-4000-8000-000000000001';
const range = { from: '2026-03-01', to: '2026-04-01' };

function world() {
  const statement = { customer: { id: CUSTOMER } } as CustomerStatementDto;
  const pdf = Buffer.from('%PDF-1.3');
  const statementService = {
    getStatement: jest.fn().mockResolvedValue(statement),
  };
  const pdfService = {
    renderCustomerStatementPdf: jest.fn().mockResolvedValue(pdf),
  };
  return {
    statement,
    pdf,
    statementService,
    pdfService,
    deps: {
      statementService: statementService as unknown as CustomerStatementService,
      pdfGenerationService: pdfService as unknown as PdfGenerationService,
    },
  };
}

describe('renderCustomerStatementPdfFor', () => {
  it('reads the statement for the customer + period, then renders it', async () => {
    const { deps, statement, pdf, statementService, pdfService } = world();
    await expect(
      renderCustomerStatementPdfFor(deps, CUSTOMER, range),
    ).resolves.toBe(pdf);
    expect(statementService.getStatement).toHaveBeenCalledWith(CUSTOMER, {
      from: range.from,
      to: range.to,
    });
    expect(pdfService.renderCustomerStatementPdf).toHaveBeenCalledWith(
      statement,
    );
  });

  it('a read failure (404) is propagated and nothing is rendered', async () => {
    const { deps, statementService, pdfService } = world();
    statementService.getStatement.mockRejectedValueOnce(new Error('404'));
    await expect(
      renderCustomerStatementPdfFor(deps, CUSTOMER, range),
    ).rejects.toThrow('404');
    expect(pdfService.renderCustomerStatementPdf).not.toHaveBeenCalled();
  });
});

describe('SalesCustomerStatementController', () => {
  it('still requires only read:Sale', () => {
    const handler = Object.getOwnPropertyDescriptor(
      SalesCustomerStatementController.prototype,
      'statementPdf',
    )?.value as object;
    expect(Reflect.getMetadata(PERMISSIONS_KEY, handler)).toEqual([
      ['read', 'Sale'],
    ]);
  });

  it('sends the rendered PDF with the unchanged headers', async () => {
    const { statementService, pdfService, pdf } = world();
    const controller = new SalesCustomerStatementController(
      statementService as unknown as CustomerStatementService,
      pdfService as unknown as PdfGenerationService,
    );
    const res = { set: jest.fn(), send: jest.fn() };
    await controller.statementPdf(CUSTOMER, range, res as never);

    expect(res.set).toHaveBeenCalledWith({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="estado-de-cuenta-${CUSTOMER}-2026-03-01-2026-04-01.pdf"`,
      'Cache-Control': 'no-store',
    });
    expect(res.send).toHaveBeenCalledWith(pdf);
  });

  it('filename stays user-data-free and re-sanitized', () => {
    expect(
      buildCustomerStatementPdfFilename('a"b', {
        from: '2026-03-01\r\n',
        to: '2026-04-01',
      }),
    ).toBe('estado-de-cuenta-ab-2026-03-01-2026-04-01.pdf');
  });
});
