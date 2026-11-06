/**
 * shipping-zones / T7 (S10) — where and when a pickup order is collected.
 *
 *   name    — the sucursal (tenant) name;
 *   address — the T2 shipping origin; without one, the free-text
 *             `Tenant.address` as `formatted` only; null when neither exists;
 *   hours   — the opening hours formatted for the bot; null until set.
 *
 * Reads go through the transaction-aware client, so the checkout builds it
 * inside its own transaction and caches it with the idempotent response.
 */
import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../../shared/prisma/tenant-prisma.service';
import {
  formatOpeningHoursEs,
  type FormattedOpeningHours,
} from '../domain/opening-hours';
import { OpeningHoursService } from './opening-hours.service';

export interface PickupAddress {
  addressLine1: string | null;
  addressLine2: string | null;
  neighborhood: string | null;
  municipality: string | null;
  state: string | null;
  postalCode: string | null;
  /** One line in Spanish, ready to show to the customer. */
  formatted: string;
}

export interface PickupLocation {
  name: string;
  address: PickupAddress | null;
  hours: FormattedOpeningHours | null;
}

@Injectable()
export class PickupLocationService {
  constructor(
    private readonly tenantPrisma: TenantPrismaService,
    private readonly openingHours: OpeningHoursService,
  ) {}

  async resolve(tenantId: string): Promise<PickupLocation> {
    const db = this.tenantPrisma.getClient();
    const [tenant, origin, hours] = await Promise.all([
      db.tenant.findUnique({
        where: { id: tenantId },
        select: { name: true, address: true },
      }),
      db.shippingOrigin.findFirst({ where: { tenantId } }),
      this.openingHours.findHours(tenantId),
    ]);
    let address: PickupAddress | null = null;
    if (origin) {
      address = {
        addressLine1: origin.addressLine1,
        addressLine2: origin.addressLine2,
        neighborhood: origin.neighborhood,
        municipality: origin.municipality,
        state: origin.state,
        postalCode: origin.postalCode,
        formatted: [
          origin.addressLine1,
          origin.addressLine2,
          origin.neighborhood,
          origin.municipality,
          origin.state,
          `C.P. ${origin.postalCode}`,
        ]
          .filter(Boolean)
          .join(', '),
      };
    } else if (tenant?.address?.trim()) {
      address = {
        addressLine1: null,
        addressLine2: null,
        neighborhood: null,
        municipality: null,
        state: null,
        postalCode: null,
        formatted: tenant.address.trim(),
      };
    }
    return {
      name: tenant?.name ?? '',
      address,
      hours: hours ? formatOpeningHoursEs(hours) : null,
    };
  }
}
