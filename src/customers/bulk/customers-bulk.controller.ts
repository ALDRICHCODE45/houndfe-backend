import {
  Body,
  CallHandler,
  Controller,
  ExecutionContext,
  HttpCode,
  HttpStatus,
  Injectable,
  NestInterceptor,
  Post,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import type { Observable } from 'rxjs';
import type { Request, Response } from 'express';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { InsufficientPermissionsError } from '../../shared/domain/domain-error';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { assertNoReservedBulkBodyKeys } from './customer-bulk-filter';
import { holdsCustomerExportPermission } from './customer-export.permission';
import { CustomersBulkExportBodyDto } from './customers-bulk-export.dto';
import { CustomersBulkExportService } from './customers-bulk-export.service';

type BulkRequest = Request & { ability?: AppAbility; user: AuthenticatedUser };

/**
 * Advisory R3-filter-proto-key: Nest's `ValidationPipe` deletes own
 * `__proto__` / `prototype` / `constructor` keys from the body IN PLACE
 * (`stripProtoKeys`) before validating, so an unknown filter param spelled
 * that way would be silently accepted. Interceptors run after the guards and
 * before the pipes: reject it here with the 400 any unknown filter param gets.
 * The same holds anywhere else in the body (top level, `selection`, nested
 * plain objects): those get the 400 an unknown property gets at that path.
 */
@Injectable()
export class RejectReservedBulkFilterKeysInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<Request>();
    assertNoReservedBulkBodyKeys(req.body);
    return next.handle();
  }
}

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
  @UseInterceptors(RejectReservedBulkFilterKeysInterceptor)
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
    const actor = { userId: req.user.userId, tenantId: req.user.tenantId };
    if (!holdsCustomerExportPermission(req.ability)) {
      // The route guard already passed (e.g. `manage:Customer`): log it.
      this.exportService.logDenied(
        body,
        actor,
        'EXPORT_PERMISSION_NOT_EXPLICIT',
      );
      throw new InsufficientPermissionsError();
    }
    const result = await this.exportService.export(body, req.ability, actor);
    res.set({
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="${result.filename}"`,
      'Cache-Control': 'no-store',
    });
    res.send(result.csv);
  }
}
