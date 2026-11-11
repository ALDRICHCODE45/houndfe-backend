import { Inject, Injectable } from '@nestjs/common';
import { PickupLocationService } from '../../../shipping/pickup/application/pickup-location.service';
import type { PublicBranchDetailDto } from '../dto/public-branch-detail.dto';
import {
  type IPublicCatalogRepository,
  PUBLIC_CATALOG_REPOSITORY,
} from '../ports/public-catalog.repository';
import { PublicCatalogConfig } from '../services/public-catalog-config';

/**
 * Public catalog v0 (S4) — the guarded tenant's branch card: name, public
 * phone, pickup address and hours (reusing `PickupLocationService.resolve`),
 * the pickup/delivery flags and the bot's WhatsApp number. The tenant is the
 * one `PublicTenantGuard` already admitted.
 */
@Injectable()
export class GetPublicBranchUseCase {
  constructor(
    @Inject(PUBLIC_CATALOG_REPOSITORY)
    private readonly repo: IPublicCatalogRepository,
    private readonly pickupLocation: PickupLocationService,
    private readonly config: PublicCatalogConfig,
  ) {}

  async execute(tenant: { id: string }): Promise<PublicBranchDetailDto> {
    const [location, profile] = await Promise.all([
      this.pickupLocation.resolve(tenant.id),
      this.repo.findPublicBranchProfile(tenant.id),
    ]);
    return {
      name: location.name,
      phone: profile.phone,
      address: location.address,
      hours: location.hours,
      pickupAvailable: location.address !== null,
      deliveryAvailable: profile.deliveryAvailable,
      whatsappNumber: this.config.botWhatsappNumber(),
    };
  }
}
