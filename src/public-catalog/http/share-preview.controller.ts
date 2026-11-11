import {
  ArgumentsHost,
  Catch,
  Controller,
  ExceptionFilter,
  Get,
  NotFoundException,
  Param,
  Query,
  Res,
  UseFilters,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, ThrottlerGuard } from '@nestjs/throttler';
import { isUUID } from 'class-validator';
import type { Response } from 'express';
import { PublicTenantGuard } from './guards/public-tenant.guard';
import {
  PublicTenant,
  type PublicTenantInfo,
} from './decorators/public-tenant.decorator';
import {
  renderMissRedirectHtml,
  renderSharePreviewHtml,
} from './share-preview.html';
import { GetPublicProductDetailUseCase } from '../application/use-cases/get-public-product-detail.use-case';
import { PublicPriceContextResolver } from '../application/services/public-price-context-resolver';
import { PublicCatalogConfig } from '../application/services/public-catalog-config';
import { PriceContextNotAvailableError } from '../domain/errors/price-context-not-available.error';

const PREVIEW_CACHE = 'public, max-age=300';
const MISS_CACHE = 'public, max-age=60';

function sendHtml(
  res: Response,
  status: number,
  cache: string,
  html: string,
): void {
  res
    .status(status)
    .set({
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': cache,
      'X-Content-Type-Options': 'nosniff',
    })
    .send(html);
}

/** S6 — without PUBLIC_STORE_URL there is nowhere to redirect: 503. */
function sendUnavailable(res: Response): void {
  res
    .status(503)
    .set({
      'Content-Type': 'text/plain; charset=utf-8',
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    })
    .send('Share previews are not configured');
}

function sendMiss(res: Response, storeUrl: string | null): void {
  if (storeUrl === null) return sendUnavailable(res);
  sendHtml(res, 404, MISS_CACHE, renderMissRedirectHtml(storeUrl));
}

/**
 * The tenant guard answers an unknown or unpublished slug with a
 * NotFoundException before the handler runs; on this route that is the same
 * miss as an unknown product: back to the storefront home.
 */
@Catch(NotFoundException)
export class SharePreviewMissFilter implements ExceptionFilter {
  constructor(private readonly config: PublicCatalogConfig) {}

  catch(_exception: NotFoundException, host: ArgumentsHost): void {
    sendMiss(
      host.switchToHttp().getResponse<Response>(),
      this.config.storeUrl(),
    );
  }
}

/**
 * Public catalog v0 (S6) — `GET /share/:tenantSlug/p/:productId`: Open Graph
 * HTML for link previews that redirects people to the storefront. Outside
 * auth and outside the `public/catalog` prefix. Never shows a price.
 */
@Controller('share')
@SkipThrottle({ 'public-validate': true })
@UseGuards(PublicTenantGuard, ThrottlerGuard)
@UseFilters(SharePreviewMissFilter)
export class SharePreviewController {
  constructor(
    private readonly priceContext: PublicPriceContextResolver,
    private readonly getProductDetail: GetPublicProductDetailUseCase,
    private readonly config: PublicCatalogConfig,
  ) {}

  @Get(':tenantSlug/p/:productId')
  async preview(
    @Param('tenantSlug') tenantSlug: string,
    @Param('productId') productId: string,
    @Query('priceListId') priceListId: unknown,
    @PublicTenant() tenant: PublicTenantInfo,
    @Res() res: Response,
  ): Promise<void> {
    const storeUrl = this.config.storeUrl();
    if (storeUrl === null) return sendUnavailable(res);
    if (!isUUID(productId)) return sendMiss(res, storeUrl);

    // Only a well-formed UUID is ever used or echoed; anything else is
    // ignored, as if `priceListId` were absent.
    const priceList =
      typeof priceListId === 'string' && isUUID(priceListId)
        ? priceListId
        : undefined;

    try {
      const context = await this.priceContext.resolve(tenantSlug, priceList);
      const product = await this.getProductDetail.executeForContext({
        productId,
        tenant,
        context,
      });
      const target =
        `${storeUrl}/${encodeURIComponent(tenant.slug)}/p/${productId}` +
        (priceList ? `?priceListId=${priceList}` : '');
      sendHtml(
        res,
        200,
        PREVIEW_CACHE,
        renderSharePreviewHtml({
          siteName: tenant.name,
          title: product.name,
          description: product.description,
          image: product.images[0]?.url ?? null,
          url: target,
        }),
      );
    } catch (error) {
      if (
        error instanceof PriceContextNotAvailableError ||
        error instanceof NotFoundException
      ) {
        return sendMiss(res, storeUrl);
      }
      throw error;
    }
  }
}
