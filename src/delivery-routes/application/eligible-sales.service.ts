/**
 * APPLICATION SERVICE: EligibleSalesService — delivery-routes / T4
 * (eligible-sales selector).
 *
 * Owns the selector read use case:
 *   - tenant context + authorization gate (`read:Sale` AND route-manager
 *     `create:DeliveryRoute`, the same discriminator the existing list uses)
 *   - CASL `read:Sale` row scope translation (`buildSaleReadScope`)
 *   - `contextRouteId` validation: tenant-scoped AND instance-authorized,
 *     surfaced as the existing 404 so it is never an existence oracle
 *   - availability inference (discriminated union) with the precedence
 *     INELIGIBLE → IN_CURRENT_ROUTE → OCCUPIED → AVAILABLE
 *   - permission-based redaction of `occupiedRoute` (an unreadable occupying
 *     route stays OCCUPIED, it is never downgraded to AVAILABLE)
 *
 * The reader is responsible for tenant-qualified reads and for dropping
 * foreign-tenant related rows; this service never trusts nested relations.
 */
import { Inject, Injectable } from '@nestjs/common';
import { subject as caslSubject } from '@casl/ability';
import { ClsService } from 'nestjs-cls';
import {
  InsufficientPermissionsError,
  InvalidArgumentError,
} from '../../shared/domain/domain-error';
import type { TenantClsStore } from '../../shared/tenant/tenant-cls-store.interface';
import type {
  AppAbility,
  AppSubjects,
} from '../../auth/authorization/domain/permission';
import { DeliveryRouteNotFoundError } from '../domain/delivery-route.errors';
import type { EligibleSalesQueryDto } from '../dto/eligible-sales-query.dto';
import type {
  EligibleSaleAvailabilityDto,
  EligibleSaleRowDto,
  EligibleSalesResponseDto,
} from '../dto/eligible-sales-response.dto';
import {
  ELIGIBLE_SALES_READER,
  type EligibleSaleRowProjection,
  type EligibleSalesContextRouteProjection,
  type IEligibleSalesReader,
} from './eligible-sales-reader.port';
import { buildSaleReadScope } from './eligible-sales-sale-scope';

export interface EligibleSalesRequestContext {
  userId: string;
  ability: AppAbility;
}

/** Delivery states a routable sale may hold (spec: Create DeliveryRoute). */
const ROUTABLE_DELIVERY_STATUSES = new Set(['PENDING', 'SHIPPED']);

interface CurrentRouteStop {
  stopId: string;
  sortOrder: number;
}

@Injectable()
export class EligibleSalesService {
  constructor(
    @Inject(ELIGIBLE_SALES_READER)
    private readonly reader: IEligibleSalesReader,
    private readonly cls: ClsService<TenantClsStore>,
  ) {}

  async list(
    ctx: EligibleSalesRequestContext,
    query: EligibleSalesQueryDto,
  ): Promise<EligibleSalesResponseDto> {
    const tenantId = this.requireTenantId();
    this.assertCanSelect(ctx.ability);

    const page = query.page ?? 1;
    const limit = query.limit ?? 20;
    const saleScope = buildSaleReadScope(ctx.ability);

    // IN_CURRENT_ROUTE inference depends on a validated context route: the
    // route must exist in the caller's tenant AND the caller must be able to
    // read that instance. Both misses collapse into the existing 404.
    const currentRouteStops = query.contextRouteId
      ? await this.resolveCurrentRouteStops(
          ctx.ability,
          tenantId,
          query.contextRouteId,
        )
      : new Map<string, CurrentRouteStop>();

    const { rows, total } = await this.reader.findEligibleSales({
      tenantId,
      page,
      limit,
      q: query.q,
      saleScope,
    });

    const data = rows.map((row) =>
      this.toRowDto(ctx.ability, row, currentRouteStops),
    );
    const totalPages = total === 0 ? 0 : Math.ceil(total / limit);

    return { data, pagination: { page, limit, total, totalPages } };
  }

  // ── Guards ───────────────────────────────────────────────────────────

  private assertCanSelect(ability: AppAbility): void {
    if (!ability.can('read', 'Sale')) {
      throw new InsufficientPermissionsError();
    }
    if (!ability.can('create', 'DeliveryRoute')) {
      throw new InsufficientPermissionsError();
    }
  }

  private async resolveCurrentRouteStops(
    ability: AppAbility,
    tenantId: string,
    routeId: string,
  ): Promise<Map<string, CurrentRouteStop>> {
    const route = await this.reader.findContextRoute({ tenantId, routeId });
    if (!route || !this.canReadRouteInstance(ability, route)) {
      throw new DeliveryRouteNotFoundError(routeId);
    }

    // Only a LIVE context route (DRAFT | ACTIVE) establishes current
    // membership. A COMPLETED/CANCELLED route is historical: its stops must
    // not be reported as IN_CURRENT_ROUTE (which would block re-selection),
    // so the row falls through to live occupancy inference. Existence and
    // permission are still validated above (404 on miss/unauthorized).
    const isLiveContext = route.status === 'DRAFT' || route.status === 'ACTIVE';
    if (!isLiveContext) {
      return new Map<string, CurrentRouteStop>();
    }

    const stops = new Map<string, CurrentRouteStop>();
    for (const stop of route.stops) {
      const existing = stops.get(stop.saleId);
      if (!existing || stop.sortOrder < existing.sortOrder) {
        stops.set(stop.saleId, {
          stopId: stop.stopId,
          sortOrder: stop.sortOrder,
        });
      }
    }
    return stops;
  }

  /**
   * Instance-scoped `read:DeliveryRoute` check using the CASL `subject()`
   * helper so the `{ driverUserId }` condition is actually evaluated
   * (string subjects ignore conditions — see ADR-5).
   */
  private canReadRouteInstance(
    ability: AppAbility,
    route: Pick<EligibleSalesContextRouteProjection, 'driverUserId'>,
  ): boolean {
    const instance = caslSubject('DeliveryRoute', {
      driverUserId: route.driverUserId,
    });
    // SAFETY: CASL's `can` overloads accept `AppSubjects`, while `subject()`
    // returns a tagged object whose runtime tag drives condition matching.
    // The cast is a type-only bridge; runtime behavior is unchanged.
    return ability.can('read', instance as unknown as AppSubjects);
  }

  // ── Mapping ──────────────────────────────────────────────────────────

  private toRowDto(
    ability: AppAbility,
    row: EligibleSaleRowProjection,
    currentRouteStops: Map<string, CurrentRouteStop>,
  ): EligibleSaleRowDto {
    return {
      id: row.id,
      folio: row.folio,
      status: row.status,
      paymentStatus: row.paymentStatus,
      deliveryStatus: row.deliveryStatus,
      totalCents: row.totalCents,
      debtCents: row.debtCents,
      confirmedAt: row.confirmedAt ? row.confirmedAt.toISOString() : null,
      dueDate: row.dueDate ? row.dueDate.toISOString() : null,
      customer: row.customer
        ? {
            id: row.customer.id,
            name: this.formatCustomerName(row.customer),
          }
        : null,
      shippingAddress: row.shippingAddress
        ? {
            id: row.shippingAddress.id,
            label: row.shippingAddress.label,
            street: row.shippingAddress.street,
            exteriorNumber: row.shippingAddress.exteriorNumber,
            interiorNumber: row.shippingAddress.interiorNumber,
            neighborhood: row.shippingAddress.neighborhood,
            municipality: row.shippingAddress.municipality,
            city: row.shippingAddress.city,
            state: row.shippingAddress.state,
            zipCode: row.shippingAddress.zipCode,
          }
        : null,
      productSummary: row.productNames.slice(0, 3),
      availability: this.inferAvailability(ability, row, currentRouteStops),
    };
  }

  /**
   * Precedence: INELIGIBLE (missing address, then delivery state) →
   * IN_CURRENT_ROUTE → OCCUPIED → AVAILABLE.
   *
   * An occupying route the caller cannot read is still OCCUPIED with a
   * `null` `occupiedRoute` detail — forbidden is never reported as
   * AVAILABLE. A marker whose route status is outside `{DRAFT, ACTIVE}` is
   * also kept OCCUPIED (never AVAILABLE) with a `null` detail, because the
   * marker itself is the authoritative reservation signal.
   */
  private inferAvailability(
    ability: AppAbility,
    row: EligibleSaleRowProjection,
    currentRouteStops: Map<string, CurrentRouteStop>,
  ): EligibleSaleAvailabilityDto {
    if (!row.shippingAddress) {
      return { state: 'INELIGIBLE', reason: 'MISSING_ADDRESS' };
    }
    if (!ROUTABLE_DELIVERY_STATUSES.has(row.deliveryStatus)) {
      return { state: 'INELIGIBLE', reason: 'DELIVERY_STATUS' };
    }

    const current = currentRouteStops.get(row.id);
    if (current) {
      return {
        state: 'IN_CURRENT_ROUTE',
        stopId: current.stopId,
        sortOrder: current.sortOrder,
      };
    }

    if (row.occupancy) {
      const routeStatus = row.occupancy.routeStatus;
      const exposableStatus: 'DRAFT' | 'ACTIVE' | null =
        routeStatus === 'DRAFT' || routeStatus === 'ACTIVE'
          ? routeStatus
          : null;
      if (exposableStatus === null) {
        return {
          state: 'OCCUPIED',
          reason: 'RESERVED_BY_ROUTE',
          occupiedRoute: null,
        };
      }
      const exposable = this.canReadRouteInstance(ability, {
        driverUserId: row.occupancy.routeDriverUserId,
      });
      return {
        state: 'OCCUPIED',
        reason: 'RESERVED_BY_ROUTE',
        occupiedRoute: exposable
          ? { id: row.occupancy.routeId, status: exposableStatus }
          : null,
      };
    }

    return { state: 'AVAILABLE' };
  }

  private formatCustomerName(customer: {
    firstName: string;
    lastName: string | null;
  }): string {
    return `${customer.firstName}${
      customer.lastName ? ' ' + customer.lastName : ''
    }`.trim();
  }

  private requireTenantId(): string {
    const { tenantId, isSuperAdmin } = this.cls.get();
    if (!tenantId && !isSuperAdmin) {
      throw new InvalidArgumentError(
        'Tenant context required',
        'TENANT_CONTEXT_REQUIRED',
      );
    }
    if (!tenantId) {
      throw new InvalidArgumentError(
        'Eligible sales reads require an explicit tenant',
        'TENANT_CONTEXT_REQUIRED',
      );
    }
    return tenantId;
  }
}
