import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { InsufficientPermissionsError } from '../../shared/domain/domain-error';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { holdsCustomerExportPermission } from './customer-export.permission';
import { CustomersBulkExportBodyDto } from './customers-bulk-export.dto';
import { CustomersBulkExportService } from './customers-bulk-export.service';

type BulkRequest = Request & { ability?: AppAbility; user: AuthenticatedUser };

/**
 * customers-bulk-actions / T1 — `POST /customers/bulk/export`
 * (`docs/proposals/customers-bulk-actions-contract.md` §4, owner L3).
 *
 * Registered BEFORE `CustomersController` in `CustomersModule`, like the
 * listing controller.
 */
@Controller('customers/bulk')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class CustomersBulkController {
  constructor(private readonly exportService: CustomersBulkExportService) {}

  /**
   * `read:Customer` + the special `export:Customer` (explicit row or the super
   * admin's `manage:all`; `manage:Customer` is not enough). `read:Sale` adds
   * the metric columns and allows metric filters / sorts.
   */
  @Post('export')
  @HttpCode(HttpStatus.OK)
  @RequirePermissions(['read', 'Customer'], ['export', 'Customer'])
  async export(
    @Body() body: CustomersBulkExportBodyDto,
    @Req() req: BulkRequest,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    if (!req.ability) {
      throw new Error(
        'PermissionsGuard must attach request.ability (customers-bulk wiring).',
      );
    }
    if (!holdsCustomerExportPermission(req.ability)) {
      throw new InsufficientPermissionsError();
    }
    const result = await this.exportService.export(body, req.ability, {
      userId: req.user.userId,
      tenantId: req.user.tenantId,
    });
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'Cache-Control': 'no-store',
    });
    res.send(result.csv);
  }
}
