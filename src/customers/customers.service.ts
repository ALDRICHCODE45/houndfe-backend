import { Inject, Injectable } from '@nestjs/common';
import { Customer } from './domain/customer.entity';
import type { ICustomerRepository } from './domain/customer.repository';
import { CUSTOMER_REPOSITORY } from './domain/customer.repository';
import { CreateCustomerDto } from './dto/create-customer.dto';
import { UpdateCustomerDto } from './dto/update-customer.dto';
import { CreateAddressDto } from './dto/address.dto';
import { UpdateAddressDto } from './dto/address.dto';
import {
  EntityNotFoundError,
  InvalidArgumentError,
} from '../shared/domain/domain-error';
import { PrismaService } from '../shared/prisma/prisma.service';

@Injectable()
export class CustomersService {
  constructor(
    @Inject(CUSTOMER_REPOSITORY)
    private readonly customerRepo: ICustomerRepository,
    private readonly prisma: PrismaService,
  ) {}

  // ==================== Customer CRUD ====================

  async create(dto: CreateCustomerDto) {
    const customer = Customer.create({
      id: crypto.randomUUID(),
      firstName: dto.firstName,
      lastName: dto.lastName,
      phoneCountryCode: dto.phoneCountryCode,
      phone: dto.phone,
      email: dto.email,
      globalPriceListId: dto.globalPriceListId,
      comments: dto.comments,
      businessName: dto.businessName,
      fiscalZipCode: dto.fiscalZipCode,
      rfc: dto.rfc,
      fiscalRegime: dto.fiscalRegime,
      billingStreet: dto.billingStreet,
      billingExteriorNumber: dto.billingExteriorNumber,
      billingInteriorNumber: dto.billingInteriorNumber,
      billingZipCode: dto.billingZipCode,
      billingNeighborhood: dto.billingNeighborhood,
      billingMunicipality: dto.billingMunicipality,
      billingCity: dto.billingCity,
      billingState: dto.billingState,
    });

    const customerId = customer.id;
    const p = customer.toPersistence();

    await this.prisma.$transaction(async (tx) => {
      await tx.customer.create({
        // @ts-expect-error tenantId auto-injected by Prisma tenant extension
        data: p,
      });

      if (dto.addresses?.length) {
        await tx.customerAddress.createMany({
          // @ts-expect-error tenantId auto-injected by Prisma tenant extension
          data: dto.addresses.map((addr) => ({
            customerId,
            street: addr.street.trim(),
            exteriorNumber: addr.exteriorNumber?.trim() || null,
            interiorNumber: addr.interiorNumber?.trim() || null,
            zipCode: addr.zipCode?.trim() || null,
            neighborhood: addr.neighborhood?.trim() || null,
            municipality: addr.municipality?.trim() || null,
            city: addr.city?.trim() || null,
            state: addr.state ?? null,
          })),
        });
      }
    });

    return this.buildFullResponse(customerId);
  }

  async findAll() {
    const customers = await this.prisma.customer.findMany({
      orderBy: { createdAt: 'desc' },
      include: {
        globalPriceList: { select: { id: true, name: true } },
        addresses: { orderBy: { createdAt: 'asc' } },
      },
    });

    return customers.map((c) => ({
      ...Customer.fromPersistence({
        id: c.id,
        firstName: c.firstName,
        lastName: c.lastName,
        phoneCountryCode: c.phoneCountryCode,
        phone: c.phone,
        email: c.email,
        globalPriceListId: c.globalPriceListId,
        comments: c.comments,
        businessName: c.businessName,
        fiscalZipCode: c.fiscalZipCode,
        rfc: c.rfc,
        fiscalRegime: c.fiscalRegime,
        billingStreet: c.billingStreet,
        billingExteriorNumber: c.billingExteriorNumber,
        billingInteriorNumber: c.billingInteriorNumber,
        billingZipCode: c.billingZipCode,
        billingNeighborhood: c.billingNeighborhood,
        billingMunicipality: c.billingMunicipality,
        billingCity: c.billingCity,
        billingState: c.billingState,
        createdAt: c.createdAt,
        updatedAt: c.updatedAt,
      }).toResponse(),
      globalPriceList: c.globalPriceList ?? null,
      addresses: c.addresses,
    }));
  }

  async findOne(id: string) {
    return this.buildFullResponse(id);
  }

  async update(id: string, dto: UpdateCustomerDto) {
    const customer = await this.customerRepo.findById(id);
    if (!customer) throw new EntityNotFoundError('Customer', id);

    if (dto.firstName !== undefined) {
      const trimmed = dto.firstName.trim();
      if (!trimmed)
        throw new InvalidArgumentError('Customer first name is required');
      customer.firstName = trimmed;
    }
    if (dto.lastName !== undefined)
      customer.lastName = dto.lastName?.trim() || null;
    if (dto.phoneCountryCode !== undefined)
      customer.phoneCountryCode = dto.phoneCountryCode?.trim() || null;
    if (dto.phone !== undefined) customer.phone = dto.phone?.trim() || null;
    if (dto.email !== undefined)
      customer.email = dto.email?.trim().toLowerCase() || null;
    if (dto.globalPriceListId !== undefined)
      customer.globalPriceListId = dto.globalPriceListId || null;
    if (dto.comments !== undefined)
      customer.comments = dto.comments?.trim() || null;

    // Billing fields
    if (dto.businessName !== undefined)
      customer.businessName = dto.businessName?.trim() || null;
    if (dto.fiscalZipCode !== undefined)
      customer.fiscalZipCode = dto.fiscalZipCode?.trim() || null;
    if (dto.rfc !== undefined)
      customer.rfc = dto.rfc?.trim().toUpperCase() || null;
    if (dto.fiscalRegime !== undefined)
      customer.fiscalRegime = dto.fiscalRegime || null;
    if (dto.billingStreet !== undefined)
      customer.billingStreet = dto.billingStreet?.trim() || null;
    if (dto.billingExteriorNumber !== undefined)
      customer.billingExteriorNumber =
        dto.billingExteriorNumber?.trim() || null;
    if (dto.billingInteriorNumber !== undefined)
      customer.billingInteriorNumber =
        dto.billingInteriorNumber?.trim() || null;
    if (dto.billingZipCode !== undefined)
      customer.billingZipCode = dto.billingZipCode?.trim() || null;
    if (dto.billingNeighborhood !== undefined)
      customer.billingNeighborhood = dto.billingNeighborhood?.trim() || null;
    if (dto.billingMunicipality !== undefined)
      customer.billingMunicipality = dto.billingMunicipality?.trim() || null;
    if (dto.billingCity !== undefined)
      customer.billingCity = dto.billingCity?.trim() || null;
    if (dto.billingState !== undefined)
      customer.billingState = dto.billingState || null;

    customer.updatedAt = new Date();
    await this.customerRepo.save(customer);

    return this.buildFullResponse(id);
  }

  async remove(id: string): Promise<void> {
    const customer = await this.customerRepo.findById(id);
    if (!customer) throw new EntityNotFoundError('Customer', id);
    await this.customerRepo.delete(id);
  }

  // ==================== Addresses ====================

  async addAddress(customerId: string, dto: CreateAddressDto) {
    const customer = await this.customerRepo.findById(customerId);
    if (!customer) throw new EntityNotFoundError('Customer', customerId);

    return this.prisma.customerAddress.create({
      // @ts-expect-error tenantId auto-injected by Prisma tenant extension
      data: {
        customerId,
        street: dto.street.trim(),
        exteriorNumber: dto.exteriorNumber?.trim() || null,
        interiorNumber: dto.interiorNumber?.trim() || null,
        zipCode: dto.zipCode?.trim() || null,
        neighborhood: dto.neighborhood?.trim() || null,
        municipality: dto.municipality?.trim() || null,
        city: dto.city?.trim() || null,
        state: dto.state ?? null,
      },
    });
  }

  async getAddresses(customerId: string) {
    const customer = await this.customerRepo.findById(customerId);
    if (!customer) throw new EntityNotFoundError('Customer', customerId);

    return this.prisma.customerAddress.findMany({
      where: { customerId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async updateAddress(
    customerId: string,
    addressId: string,
    dto: UpdateAddressDto,
  ) {
    const address = await this.prisma.customerAddress.findFirst({
      where: { id: addressId, customerId },
    });
    if (!address) throw new EntityNotFoundError('CustomerAddress', addressId);

    return this.prisma.customerAddress.update({
      where: { id: addressId },
      data: {
        ...(dto.street !== undefined ? { street: dto.street.trim() } : {}),
        ...(dto.exteriorNumber !== undefined
          ? { exteriorNumber: dto.exteriorNumber?.trim() || null }
          : {}),
        ...(dto.interiorNumber !== undefined
          ? { interiorNumber: dto.interiorNumber?.trim() || null }
          : {}),
        ...(dto.zipCode !== undefined
          ? { zipCode: dto.zipCode?.trim() || null }
          : {}),
        ...(dto.neighborhood !== undefined
          ? { neighborhood: dto.neighborhood?.trim() || null }
          : {}),
        ...(dto.municipality !== undefined
          ? { municipality: dto.municipality?.trim() || null }
          : {}),
        ...(dto.city !== undefined ? { city: dto.city?.trim() || null } : {}),
        ...(dto.state !== undefined ? { state: dto.state || null } : {}),
      },
    });
  }

  async removeAddress(customerId: string, addressId: string): Promise<void> {
    const address = await this.prisma.customerAddress.findFirst({
      where: { id: addressId, customerId },
    });
    if (!address) throw new EntityNotFoundError('CustomerAddress', addressId);
    await this.prisma.customerAddress.delete({ where: { id: addressId } });
  }

  // ==================== Helpers ====================

  private async buildFullResponse(customerId: string) {
    const data = await this.prisma.customer.findUnique({
      where: { id: customerId },
      include: {
        globalPriceList: { select: { id: true, name: true } },
        addresses: { orderBy: { createdAt: 'asc' } },
      },
    });

    if (!data) throw new EntityNotFoundError('Customer', customerId);

    const customer = Customer.fromPersistence({
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

    return {
      ...customer.toResponse(),
      globalPriceList: data.globalPriceList ?? null,
      addresses: data.addresses,
    };
  }
}
