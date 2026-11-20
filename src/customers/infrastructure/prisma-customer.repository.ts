import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { Customer } from '../domain/customer.entity';
import type { ICustomerRepository } from '../domain/customer.repository';
import { Prisma, type Customer as PrismaCustomer } from '@prisma/client';
import { CustomerHasActiveBackordersError } from '../domain/customer-has-active-backorders.error';

/** Backorders that still hold a place in the queue or a reservation. */
const ACTIVE_BACKORDER_STATUSES = ['WAITING', 'RESERVED'] as const;
/** Finished backorders; deleted together with their customer (owner, L5). */
const TERMINAL_BACKORDER_STATUSES = [
  'CONFIRMED',
  'EXPIRED',
  'CANCELLED',
] as const;

@Injectable()
export class PrismaCustomerRepository implements ICustomerRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async findById(id: string): Promise<Customer | null> {
    const prisma = this.tenantPrisma.getClient();
    const data = await prisma.customer.findUnique({ where: { id } });
    return data ? this.toDomain(data) : null;
  }

  async findByPhone(
    tenantId: string,
    countryCode: string,
    phone: string,
  ): Promise<Customer | null> {
    const prisma = this.tenantPrisma.getClient();
    const data = await prisma.customer.findFirst({
      where: {
        tenantId,
        phoneCountryCode: countryCode,
        phone,
      },
      orderBy: { createdAt: 'desc' },
    });

    return data ? this.toDomain(data) : null;
  }

  async findAll(): Promise<Customer[]> {
    const prisma = this.tenantPrisma.getClient();
    const data = await prisma.customer.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return data.map((d) => this.toDomain(d));
  }

  async save(customer: Customer): Promise<Customer> {
    const prisma = this.tenantPrisma.getClient();
    const tenantId = this.tenantPrisma.getTenantId();
    const p = customer.toPersistence();
    const saved = await prisma.customer.upsert({
      where: { id: p.id },
      update: {
        firstName: p.firstName,
        lastName: p.lastName,
        phoneCountryCode: p.phoneCountryCode,
        phone: p.phone,
        email: p.email,
        globalPriceListId: p.globalPriceListId,
        comments: p.comments,
        preferredPaymentMethod: p.preferredPaymentMethod,
        businessName: p.businessName,
        fiscalZipCode: p.fiscalZipCode,
        rfc: p.rfc,
        fiscalRegime: p.fiscalRegime,
        billingStreet: p.billingStreet,
        billingExteriorNumber: p.billingExteriorNumber,
        billingInteriorNumber: p.billingInteriorNumber,
        billingZipCode: p.billingZipCode,
        billingNeighborhood: p.billingNeighborhood,
        billingMunicipality: p.billingMunicipality,
        billingCity: p.billingCity,
        billingState: p.billingState,
        updatedAt: new Date(),
      },
      create: {
        id: p.id,
        firstName: p.firstName,
        lastName: p.lastName,
        phoneCountryCode: p.phoneCountryCode,
        phone: p.phone,
        email: p.email,
        globalPriceListId: p.globalPriceListId,
        comments: p.comments,
        preferredPaymentMethod: p.preferredPaymentMethod,
        businessName: p.businessName,
        fiscalZipCode: p.fiscalZipCode,
        rfc: p.rfc,
        fiscalRegime: p.fiscalRegime,
        billingStreet: p.billingStreet,
        billingExteriorNumber: p.billingExteriorNumber,
        billingInteriorNumber: p.billingInteriorNumber,
        billingZipCode: p.billingZipCode,
        billingNeighborhood: p.billingNeighborhood,
        billingMunicipality: p.billingMunicipality,
        billingCity: p.billingCity,
        billingState: p.billingState,
        tenantId,
      } as Prisma.CustomerUncheckedCreateInput,
    });
    return this.toDomain(saved);
  }

  /**
   * One transaction: lock the customer row, refuse while a WAITING/RESERVED
   * backorder exists, otherwise delete the terminal backorders and the
   * customer. `FOR UPDATE` conflicts with the key-share lock a concurrent
   * backorder insert takes on the customer, so an active backorder can neither
   * slip in after the check nor be missed by it. The business FKs are RESTRICT,
   * hence the explicit delete of the terminal rows first.
   */
  async delete(id: string): Promise<void> {
    const tenantId = this.tenantPrisma.getTenantId();
    await this.tenantPrisma.runInTransaction(async () => {
      const tx = this.tenantPrisma.getClient();
      await tx.$queryRaw`
        SELECT id FROM customers WHERE id = ${id} AND "tenantId" = ${tenantId} FOR UPDATE
      `;
      const active = await tx.backorder.findFirst({
        where: {
          customerId: id,
          status: { in: [...ACTIVE_BACKORDER_STATUSES] },
        },
        select: { id: true },
      });
      if (active) throw new CustomerHasActiveBackordersError();
      await tx.backorder.deleteMany({
        where: {
          customerId: id,
          status: { in: [...TERMINAL_BACKORDER_STATUSES] },
        },
      });
      await tx.customer.delete({ where: { id } });
    });
  }

  private toDomain(data: PrismaCustomer): Customer {
    return Customer.fromPersistence({
      id: data.id,
      firstName: data.firstName,
      lastName: data.lastName,
      phoneCountryCode: data.phoneCountryCode,
      phone: data.phone,
      email: data.email,
      globalPriceListId: data.globalPriceListId,
      comments: data.comments,
      preferredPaymentMethod: data.preferredPaymentMethod,
      businessName: data.businessName,
      fiscalZipCode: data.fiscalZipCode,
      rfc: data.rfc,
      fiscalRegime: data.fiscalRegime,
      billingStreet: data.billingStreet,
      billingExteriorNumber: data.billingExteriorNumber,
      billingInteriorNumber: data.billingInteriorNumber,
      billingZipCode: data.billingZipCode,
      billingNeighborhood: data.billingNeighborhood,
      billingMunicipality: data.billingMunicipality,
      billingCity: data.billingCity,
      billingState: data.billingState,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    });
  }
}
