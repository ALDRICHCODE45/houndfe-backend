import type { PickupAddress } from '../../../shipping/pickup/application/pickup-location.service';
import type { FormattedOpeningHours } from '../../../shipping/pickup/domain/opening-hours';

/**
 * Public catalog v0 (S4) — the guarded tenant's public branch card.
 * Never carries the internal contact phone of the shipping origin.
 */
export interface PublicBranchDetailDto {
  name: string;
  /** The tenant's public phone (same value as `/branches`), or null. */
  phone: string | null;
  /** Pickup address (structured + one formatted line), or null. */
  address: PickupAddress | null;
  /** Weekly hours formatted in Spanish, or null until configured. */
  hours: FormattedOpeningHours | null;
  /** True when there is an address to collect an order from. */
  pickupAvailable: boolean;
  /** True when at least one active delivery zone is not DENIED. */
  deliveryAvailable: boolean;
  /** The bot's single WhatsApp number (E.164), or null when unset. */
  whatsappNumber: string | null;
}
