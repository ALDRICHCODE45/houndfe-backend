import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { Customer } from '../domain/customer.entity';
import type { ICustomerRepository } from '../domain/customer.repository';
import type { Customer as PrismaCustomer } from '@prisma/client';

@Injectable()
export class PrismaCustomerRepository implements ICustomerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Customer | null> {
    const data = await this.prisma.customer.findUnique({ where: { id } });
    return data ? this.toDomain(data) : null;
  }

  async findAll(): Promise<Customer[]> {
    const data = await this.prisma.customer.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return data.map((d) => this.toDomain(d));
  }

  async save(customer: Customer): Promise<Customer> {
    const p = customer.toPersistence();
    const saved = await this.prisma.customer.upsert({
      where: { id: p.id },
      update: {
        firstName: p.firstName,
        lastName: p.lastName,
        phoneCountryCode: p.phoneCountryCode,
        phone: p.phone,
        email: p.email,
        globalPriceListId: p.globalPriceListId,
        comments: p.comments,
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
      },
    });
    return this.toDomain(saved);
  }

  async delete(id: string): Promise<void> {
    await this.prisma.customer.delete({ where: { id } });
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
