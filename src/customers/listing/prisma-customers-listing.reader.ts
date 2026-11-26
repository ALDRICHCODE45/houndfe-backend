import { Injectable } from '@nestjs/common';
import { BusinessRuleViolationError } from '../../shared/domain/domain-error';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import {
  toCustomerSalesMetrics,
  type CustomerSalesMetricsRecord,
} from './customer-sales-metrics.sql';
import type {
  CustomerListingRow,
  CustomersListingOption,
  CustomersListingOptionsInput,
  CustomersListingReadInput,
  CustomersListingReader,
  CustomersListingSummary,
} from './customer-listing.types';
import { buildListingOptionsSql } from './customers-listing-options.sql';
import {
  buildListingPageSql,
  buildListingSummarySql,
  hasLocationFilters,
} from './customers-listing.sql';

interface PageRecord extends Partial<CustomerSalesMetricsRecord> {
  id: string;
  firstName: string;
  lastName: string | null;
  businessName: string | null;
  phoneCountryCode: string | null;
  phone: string | null;
  email: string | null;
  globalPriceListId: string | null;
  globalPriceListName: string | null;
  rfc: string | null;
  fiscalRegime: string | null;
  preferredPaymentMethod: string | null;
  isTrusted: boolean;
  createdAt: Date;
  addressId: string | null;
  addressNeighborhood: string | null;
  addressMunicipality: string | null;
  addressCity: string | null;
  addressState: string | null;
  addressZipCode: string | null;
  activePetsCount: number;
  petSpecies: string[];
  matchedPetName: string | null;
  matchedAddressId?: string | null;
}

/**
 * customers-listing — raw SQL reader of `GET /customers/listing` (contract
 * §12.2) and of its selector values (§5). The tenant id is read from the request context and passed
 * explicitly into every statement.
 */
@Injectable()
export class PrismaCustomersListingReader implements CustomersListingReader {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  private requireTenantId(): string {
    const tenantId = this.tenantPrisma.getTenantId();
    if (!tenantId) {
      throw new BusinessRuleViolationError(
        'TENANT_CONTEXT_REQUIRED',
        'TENANT_CONTEXT_REQUIRED',
      );
    }
    return tenantId;
  }

  async findPage(
    input: CustomersListingReadInput,
  ): Promise<CustomerListingRow[]> {
    const rows = await this.tenantPrisma
      .getClient()
      .$queryRaw<
        PageRecord[]
      >(buildListingPageSql(this.requireTenantId(), input));
    const location = hasLocationFilters(input.filters);
    return rows.map((row) => toRow(row, input.metrics !== null, location));
  }

  async listOptions(
    input: CustomersListingOptionsInput,
  ): Promise<CustomersListingOption[]> {
    const rows = await this.tenantPrisma
      .getClient()
      .$queryRaw<
        Array<{ value: string; customersCount: number }>
      >(buildListingOptionsSql(this.requireTenantId(), input));
    return rows.map((row) => ({
      value: row.value,
      customersCount: Number(row.customersCount),
    }));
  }

  async summarize(
    input: CustomersListingReadInput,
  ): Promise<CustomersListingSummary> {
    const [row] = await this.tenantPrisma.getClient().$queryRaw<
      Array<{
        count: number;
        openDebtCents?: bigint | number;
        overdueDebtCents?: bigint | number;
      }>
    >(buildListingSummarySql(this.requireTenantId(), input));
    const count = Number(row?.count ?? 0);
    if (!input.metrics) return { count };
    return {
      count,
      openDebtCents: Number(row?.openDebtCents ?? 0),
      overdueDebtCents: Number(row?.overdueDebtCents ?? 0),
    };
  }
}

function toRow(
  row: PageRecord,
  withMetrics: boolean,
  withMatchedAddress: boolean,
): CustomerListingRow {
  return {
    id: row.id,
    firstName: row.firstName,
    lastName: row.lastName,
    businessName: row.businessName,
    phoneCountryCode: row.phoneCountryCode,
    phone: row.phone,
    email: row.email,
    globalPriceList:
      row.globalPriceListId && row.globalPriceListName !== null
        ? { id: row.globalPriceListId, name: row.globalPriceListName }
        : null,
    rfc: row.rfc,
    fiscalRegime: row.fiscalRegime,
    preferredPaymentMethod: row.preferredPaymentMethod,
    isTrusted: row.isTrusted,
    createdAt: row.createdAt.toISOString(),
    primaryAddress: row.addressId
      ? {
          id: row.addressId,
          neighborhood: row.addressNeighborhood,
          municipality: row.addressMunicipality,
          city: row.addressCity,
          state: row.addressState,
          zipCode: row.addressZipCode,
        }
      : null,
    activePetsCount: Number(row.activePetsCount),
    petSpecies: row.petSpecies,
    matchedPetName: row.matchedPetName,
    // §4.4: only when a location filter is active; every listed row then
    // has a matching address (the filter is an EXISTS over the same ones).
    ...(withMatchedAddress && row.matchedAddressId
      ? { matchedAddressId: row.matchedAddressId }
      : {}),
    // Contract §10.1: the key is absent (not null) without read:Sale.
    ...(withMetrics
      ? { metrics: toCustomerSalesMetrics(row as CustomerSalesMetricsRecord) }
      : {}),
  };
}
