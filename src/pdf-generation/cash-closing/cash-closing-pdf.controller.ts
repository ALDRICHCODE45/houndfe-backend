/**
 * cash-register-closing / T5 (S3,S7) — HTTP adapter for
 * `GET /cash-closings/:id/pdf`.
 *
 * Contract:
 *   - The standard guard stack (`JwtAuthGuard` → `TenantContextGuard` →
 *     `PermissionsGuard`) plus `@RequirePermissions(['read', 'CashClosing'])`.
 *   - `:id` is validated as a UUID (`ParseUUIDPipe`) before it can reach the
 *     application port.
 *   - The actor carries the authenticated `userId` and the guard-attached CASL
 *     ability; the port rechecks tenant/instance scope. A missing ability or a
 *     denied `read:CashClosing` fails closed with a sanitized 403 here.
 *   - The response is `application/pdf` with a CRLF-safe filename built from
 *     the validated UUID/folio and `Cache-Control: private, no-store`.
 */
import {
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Req,
  Res,
  UnauthorizedException,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { JwtAuthGuard } from '../../auth/guards/jwt-auth.guard';
import { TenantContextGuard } from '../../shared/tenant/tenant-context.guard';
import { PermissionsGuard } from '../../auth/authorization/guards/permissions.guard';
import { RequirePermissions } from '../../auth/authorization/decorators/require-permissions.decorator';
import { CurrentUser } from '../../auth/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../../auth/interfaces/jwt-payload.interface';
import type { AppAbility } from '../../auth/authorization/domain/permission';
import type { CashActor } from '../../cash-register/cash-application.port';
import { CashClosingPdfService } from './cash-closing-pdf.service';

/**
 * Request augmentation: `PermissionsGuard` attaches the per-request CASL
 * ability to `request.ability` (mirrors the delivery-routes / human-decisions
 * controllers). No global type augmentation required.
 */
type RequestWithAbility = Request & { ability?: AppAbility };

@Controller('cash-closings')
@UseGuards(JwtAuthGuard, TenantContextGuard, PermissionsGuard)
export class CashClosingPdfController {
  constructor(private readonly cashClosingPdfService: CashClosingPdfService) {}

  @Get(':id/pdf')
  @RequirePermissions(['read', 'CashClosing'])
  async getClosingPdf(
    @Param('id', new ParseUUIDPipe()) id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() request: RequestWithAbility,
    @Res({ passthrough: false }) res: Response,
  ): Promise<void> {
    const actor = this.buildActor(user, request);

    const { buffer, folio } =
      await this.cashClosingPdfService.generateClosingReceipt(actor, id);

    res.set({
      'Content-Type': 'application/pdf',
      'Content-Disposition': `attachment; filename="${buildCashClosingPdfFilename(
        id,
        folio,
      )}"`,
      'Cache-Control': 'private, no-store',
    });
    res.send(buffer);
  }

  /**
   * Fail-closed actor construction: a missing principal is 401, a missing or
   * denying ability is a sanitized 403. The port runs the authoritative
   * tenant/instance check.
   */
  private buildActor(
    user: AuthenticatedUser,
    request: RequestWithAbility,
  ): CashActor {
    if (
      !user ||
      typeof user.userId !== 'string' ||
      user.userId.trim().length === 0
    ) {
      throw new UnauthorizedException('CASH_CLOSING_AUTH_REQUIRED');
    }

    const ability = request.ability;
    if (!ability || typeof ability.can !== 'function') {
      throw new ForbiddenException('CASH_CLOSING_ABILITY_REQUIRED');
    }
    if (!ability.can('read', 'CashClosing')) {
      throw new ForbiddenException('CASH_CLOSING_ACCESS_DENIED');
    }

    return { userId: user.userId, ability };
  }
}

/**
 * Build a CRLF-safe `Content-Disposition` filename from the validated UUID and
 * the frozen folio. Only `[A-Za-z0-9_-]` survives; when the folio sanitizes to
 * an empty string we fall back to the UUID. Result is always non-empty.
 */
export function buildCashClosingPdfFilename(
  closingId: string,
  folio: string,
): string {
  const sanitize = (value: string): string =>
    value.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64);
  const safeFolio = sanitize(folio);
  const safeId = sanitize(closingId);
  const base = safeFolio.length > 0 ? safeFolio : safeId;
  return `corte-caja-${base}.pdf`;
}
