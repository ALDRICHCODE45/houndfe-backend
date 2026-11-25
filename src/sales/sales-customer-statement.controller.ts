import {
  Controller,
  Get,
  Header,
  HttpCode,
  HttpStatus,
  Param,
  ParseUUIDPipe,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import { PdfGenerationService } from '../pdf-generation/pdf-generation.service';
import { CustomerStatementService } from './customer-statement.service';
import { CustomerStatementQueryDto } from './dto/customer-statement.dto';

/**
 * sales-history-redesign S11 (contract §8) — `GET /customers/:customerId/
 * statement/pdf?from=YYYY-MM-DD&to=YYYY-MM-DD`, permission `read:Sale`.
 *
 * Lives next to the customer monthly controller (sales data read through
 * `CustomerStatementService`, exported by `SalesModule`), but it is
 * REGISTERED in `PdfGenerationModule`: that module already imports
 * `SalesModule`, so registering it in `SalesModule` would need a forwardRef
 * module cycle. Snapshot read and render happen before any response header
 * (the seller report PDF route behaviour); unknown customer → `404
 * CUSTOMER_NOT_FOUND`, render failure → `500 PDF_GENERATION_FAILED`.
 */
@Controller('customers/:customerId/statement/pdf')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class SalesCustomerStatementController {
  constructor(
    private readonly statementService: CustomerStatementService,
    private readonly pdfGenerationService: PdfGenerationService,
  ) {}

  @Get()
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['read', 'Sale'])
  @Header('Cache-Control', 'no-store')
  async statementPdf(
    @Param('customerId', ParseUUIDPipe) customerId: string,
    @Query() query: CustomerStatementQueryDto,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const statement = await this.statementService.getStatement(
      customerId,
      query,
    );
    const pdf =
      await this.pdfGenerationService.renderCustomerStatementPdf(statement);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${buildCustomerStatementPdfFilename(
        customerId,
        query,
      )}"`,
      'Cache-Control': 'no-store',
    });
    res.send(pdf);
  }
}

/** Fixed, user-data-free filename; every component is re-sanitized here. */
export function buildCustomerStatementPdfFilename(
  customerId: string,
  query: Pick<CustomerStatementQueryDto, 'from' | 'to'>,
): string {
  const safe = (value: string): string => value.replace(/[^a-zA-Z0-9-]/g, '');
  return `estado-de-cuenta-${safe(customerId)}-${safe(query.from)}-${safe(query.to)}.pdf`;
}
