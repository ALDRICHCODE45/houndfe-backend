import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequirePermissions } from '../auth/authorization/decorators/require-permissions.decorator';
import type { AppAbility } from '../auth/authorization/domain/permission';
import { PermissionsGuard } from '../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../auth/interfaces/jwt-payload.interface';
import { RejectReservedBulkFilterKeysInterceptor } from '../customers/bulk/customers-bulk.controller';
import { TenantContextGuard } from '../shared/tenant/tenant-context.guard';
import {
  BULK_EXPORT_RETRY_AFTER_SECONDS,
  BulkExportBusyException,
  BulkStatementsAbortedError,
} from './customer-bulk-statements.busy-guard';
import { CustomerBulkStatementsService } from './customer-bulk-statements.service';
import { CustomerBulkStatementsBodyDto } from './dto/customer-bulk-statements.dto';

type BulkRequest = Request & { ability?: AppAbility; user: AuthenticatedUser };

/**
 * customers-bulk-actions / T3 (S5) — `POST /customers/bulk/statements`
 * (`docs/proposals/customers-bulk-actions-contract.md` §3): a ZIP with one
 * statement PDF per selected customer.
 *
 * Lives in src/sales next to the single statement route and, like it, is
 * REGISTERED in `PdfGenerationModule` (which imports `SalesModule` for the
 * statement service and `CustomersModule` for the selection resolver);
 * registering it in `SalesModule` would need a module cycle.
 *
 * Permissions: `read:Sale` (the single statement's) AND `read:Customer` (the
 * selection reads the customer table; contract §5). The whole ZIP is built
 * before any response header, so an error never arrives as half a ZIP.
 * A client disconnect ends the request quietly (no response, no error log).
 */
@Controller('customers/bulk')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class CustomerBulkStatementsController {
  constructor(private readonly service: CustomerBulkStatementsService) {}

  @Post('statements')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['read', 'Sale'], ['read', 'Customer'])
  // The validation pipe silently strips own `__proto__` / `constructor` /
  // `prototype` keys: reject them in `selection.filter` before the pipes,
  // with the 400 an unknown filter param gets (same as the CSV export).
  @UseInterceptors(RejectReservedBulkFilterKeysInterceptor)
  async statements(
    @Body() body: CustomerBulkStatementsBodyDto,
    @Req() req: BulkRequest,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    if (!req.ability) {
      throw new Error(
        'PermissionsGuard must attach request.ability (bulk statements wiring).',
      );
    }
    // A client that disconnects before the ZIP is sent stops the run at once
    // (the run guard frees the busy slot without waiting for the render).
    const abort = new AbortController();
    const onClose = () => {
      if (!res.writableEnded) abort.abort();
    };
    res.on('close', onClose);
    let result: Awaited<ReturnType<CustomerBulkStatementsService['build']>>;
    try {
      result = await this.service.build(
        body,
        req.ability,
        { userId: req.user.userId, tenantId: req.user.tenantId },
        { signal: abort.signal },
      );
    } catch (error) {
      // The client is gone: nothing to answer. End quietly instead of letting
      // Nest's filter log an unknown error as a 500 (the service already
      // logged the run as `aborted`, at warn level).
      if (error instanceof BulkStatementsAbortedError) return;
      if (error instanceof BulkExportBusyException) {
        res.setHeader('Retry-After', String(BULK_EXPORT_RETRY_AFTER_SECONDS));
      }
      throw error;
    } finally {
      res.off('close', onClose);
    }

    res.set({
      'Content-Type': 'application/zip',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'Content-Length': String(result.zip.length),
      'Cache-Control': 'no-store',
    });
    res.send(result.zip);
  }
}
