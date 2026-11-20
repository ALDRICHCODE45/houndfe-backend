/**
 * Staff (POS) routes of the restock backorder contract (v1 §9.1-§9.3).
 *
 * AUTHORITY: `JwtAuthGuard` → `TenantContextGuard` (the branch is the token's,
 * never a param) → `PermissionsGuard` (CASL, `read:Backorder` for the reads,
 * `update:Backorder` for the cancel). The actor of a cancel is the verified
 * `request.user`; no body/query value can supply a tenant or an actor.
 *
 * The bodies and the query stay `unknown` (the global pipe skips metatype
 * `Object`): the exact parsers in `domain/backorder-staff-query.ts` own the
 * validation, so every failure is the same code-only
 * `400 INVALID_BACKORDER_REQUEST`. Errors keep the module's envelope
 * `{ statusCode, error, message, ...detail }` with the detail at the ROOT (the
 * same shape as the sale-hold errors). A malformed id can never match a row: the
 * same 404 as an unknown one. Answers are `Cache-Control: no-store` (a backorder
 * changes state by itself).
 */
import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import {
  BackordersStaffService,
  type StaffBackorderPage,
} from '../application/backorders-staff.service';
import { BackorderError } from '../domain/backorder-error';
import {
  parseStaffCancelBody,
  parseStaffListQuery,
} from '../domain/backorder-staff-query';
import { toBackorderHttpError } from './backorder-http-error';
import type { BackorderStaff } from './dto/backorder-staff.response';

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function backorderId(id: string): string {
  if (!UUID_SHAPE.test(id)) throw new BackorderError('BACKORDER_NOT_FOUND');
  return id;
}

@Controller('backorders')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class BackordersStaffController {
  constructor(private readonly backorders: BackordersStaffService) {}

  /** `GET /backorders` (§9.1): `{ items, page, limit, total, counts }`. */
  @Get()
  @RequirePermissions(['read', 'Backorder'])
  async list(
    @Query() query: unknown,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StaffBackorderPage> {
    response.setHeader('Cache-Control', 'no-store');
    try {
      return await this.backorders.list(parseStaffListQuery(query));
    } catch (error) {
      throw toBackorderHttpError(error);
    }
  }

  /** `GET /backorders/:id` (§9.2): the `BackorderStaff`, or `404 BACKORDER_NOT_FOUND`. */
  @Get(':id')
  @RequirePermissions(['read', 'Backorder'])
  async findOne(
    @Param('id') id: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BackorderStaff> {
    response.setHeader('Cache-Control', 'no-store');
    try {
      return await this.backorders.findById(backorderId(id));
    } catch (error) {
      throw toBackorderHttpError(error);
    }
  }

  /**
   * `POST /backorders/:id/cancel` `{ reason?: ≤280, version }` (§9.3) → the
   * cancelled `BackorderStaff` (`200`).
   */
  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermissions(['update', 'Backorder'])
  async cancel(
    @Param('id') id: string,
    @Body() body: unknown,
    @CurrentUser() user: AuthenticatedUser,
    @Res({ passthrough: true }) response: Response,
  ): Promise<BackorderStaff> {
    response.setHeader('Cache-Control', 'no-store');
    try {
      const request = parseStaffCancelBody(body);
      return await this.backorders.cancel(
        backorderId(id),
        request,
        user.userId,
      );
    } catch (error) {
      throw toBackorderHttpError(error);
    }
  }
}
