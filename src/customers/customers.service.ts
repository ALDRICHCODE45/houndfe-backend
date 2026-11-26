import { Inject, Injectable } from '@nestjs/common';
import { Customer, normalizePhoneDigits } from './domain/customer.entity';
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
import { TenantPrismaService } from '../shared/prisma/tenant-prisma.service';
import { Prisma } from '@prisma/client';
import { petNameKey } from '../customer-pets/domain/customer-pet-rules';

/**
 * Prisma passes `contains` to `LIKE` as is, so `%`, `_` and `\` in a search
 * term would act as wildcards; escape them to match literally.
 */
export const escapeLike = (term: string) => term.replace(/[\\%_]/g, '\\$&');

@Injectable()
export class CustomersService {
  constructor(
    @Inject(CUSTOMER_REPOSITORY)
    private readonly customerRepo: ICustomerRepository,
    private readonly prisma: PrismaService,
    private readonly tenantPrisma: TenantPrismaService,
  ) {}

  // ==================== Customer CRUD ====================

  async create(dto: CreateCustomerDto) {
    const tenantId = this.tenantPrisma.getTenantId();
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
        data: { ...p, tenantId } as Prisma.CustomerUncheckedCreateInput,
      });

      if (dto.addresses?.length) {
        await tx.customerAddress.createMany({
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
            latitude: addr.latitude ?? null,
            longitude: addr.longitude ?? null,
            tenantId,
          })),
        });
      }
    });

    return this.buildFullResponse(customerId);
  }

  /**
   * Customer list, newest first. With `search` (customer-pets / T1, contract
   * §5) a customer matches through its own fields (name, e-mail, phone,
   * business name; every word must match) or through the name of one of its
   * ACTIVE pets (`nameKey`, accent-insensitive). Every item carries
   * `matchedPetName`: the pet's name when the match came only through a pet,
   * `null` when the customer matched on its own fields or there is no search.
   */
  async findAll(search?: string) {
    const prisma = this.tenantPrisma.getClient();
    const include = {
      globalPriceList: { select: { id: true, name: true } },
      addresses: { orderBy: { createdAt: 'asc' } },
    } satisfies Prisma.CustomerInclude;

    // `?search=a&search=b` arrives as an array: not a usable term.
    const term = typeof search === 'string' ? search.trim().slice(0, 100) : '';
    if (!term) {
      const customers = await prisma.customer.findMany({
        orderBy: { createdAt: 'desc' },
        include,
      });
      return customers.map((c) => this.toListItem(c, null));
    }

    const ownWhere = this.ownFieldsWhere(term);
    const petKey = petNameKey(term);
    const petMatch: Prisma.CustomerPetWhereInput = {
      status: 'ACTIVE',
      nameKey: { contains: escapeLike(petKey) },
    };
    const customers = await prisma.customer.findMany({
      where: petKey
        ? { OR: [ownWhere, { pets: { some: petMatch } }] }
        : ownWhere,
      orderBy: { createdAt: 'desc' },
      include: {
        ...include,
        pets: {
          where: petMatch,
          orderBy: [{ nameKey: 'asc' }, { createdAt: 'asc' }],
          take: 1,
          select: { name: true },
        },
      },
    });

    const withPet = customers.filter((c) => c.pets.length > 0);
    const ownIds = new Set<string>();
    if (withPet.length > 0) {
      const own = await prisma.customer.findMany({
        where: { AND: [{ id: { in: withPet.map((c) => c.id) } }, ownWhere] },
        select: { id: true },
      });
      for (const row of own) ownIds.add(row.id);
    }

    return customers.map((c) => {
      const { pets, ...rest } = c;
      const viaPetOnly = pets.length > 0 && !ownIds.has(c.id);
      return this.toListItem(rest, viaPetOnly ? pets[0].name : null);
    });
  }

  async findOne(id: string) {
    return this.buildFullResponse(id, { withPetCount: true });
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
      customer.phoneCountryCode = normalizePhoneDigits(dto.phoneCountryCode);
    if (dto.phone !== undefined)
      customer.phone = normalizePhoneDigits(dto.phone);
    if (dto.email !== undefined)
      customer.email = dto.email?.trim().toLowerCase() || null;
    if (dto.globalPriceListId !== undefined)
      customer.globalPriceListId = dto.globalPriceListId || null;
    if (dto.comments !== undefined)
      customer.comments = dto.comments?.trim() || null;
    // customers-listing T4 (contract §6.1): a JSON boolean, absent = unchanged.
    if (dto.isTrusted !== undefined) customer.isTrusted = dto.isTrusted;

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
    const tenantId = this.tenantPrisma.getTenantId();
    const customer = await this.customerRepo.findById(customerId);
    if (!customer) throw new EntityNotFoundError('Customer', customerId);

    return this.prisma.customerAddress.create({
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
        latitude: dto.latitude ?? null,
        longitude: dto.longitude ?? null,
        tenantId,
      },
    });
  }

  async getAddresses(customerId: string) {
    const prisma = this.tenantPrisma.getClient();
    const customer = await this.customerRepo.findById(customerId);
    if (!customer) throw new EntityNotFoundError('Customer', customerId);

    return prisma.customerAddress.findMany({
      where: { customerId },
      orderBy: { createdAt: 'asc' },
    });
  }

  async updateAddress(
    customerId: string,
    addressId: string,
    dto: UpdateAddressDto,
  ) {
    const prisma = this.tenantPrisma.getClient();
    const address = await prisma.customerAddress.findFirst({
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
        ...(dto.latitude !== undefined
          ? { latitude: dto.latitude, longitude: dto.longitude }
          : {}),
      },
    });
  }

  async removeAddress(customerId: string, addressId: string): Promise<void> {
    const prisma = this.tenantPrisma.getClient();
    const address = await prisma.customerAddress.findFirst({
      where: { id: addressId, customerId },
    });
    if (!address) throw new EntityNotFoundError('CustomerAddress', addressId);
    await this.prisma.customerAddress.delete({ where: { id: addressId } });
  }

  // ==================== Helpers ====================

  /** Every word of `term` must appear in one of the customer's own text fields. */
  private ownFieldsWhere(term: string): Prisma.CustomerWhereInput {
    const contains = (word: string) => ({
      contains: escapeLike(word),
      mode: 'insensitive' as const,
    });
    return {
      AND: term
        .split(/\s+/)
        .slice(0, 6)
        .map((word) => ({
          OR: [
            { firstName: contains(word) },
            { lastName: contains(word) },
            { email: contains(word) },
            { phone: contains(word) },
            { businessName: contains(word) },
          ],
        })),
    };
  }

  private toListItem(
    c: Prisma.CustomerGetPayload<{
      include: {
        globalPriceList: { select: { id: true; name: true } };
        addresses: true;
      };
    }>,
    matchedPetName: string | null,
  ) {
    return {
      ...Customer.fromPersistence({
        id: c.id,
        firstName: c.firstName,
        lastName: c.lastName,
        phoneCountryCode: c.phoneCountryCode,
        phone: c.phone,
        email: c.email,
        globalPriceListId: c.globalPriceListId,
        comments: c.comments,
        preferredPaymentMethod: c.preferredPaymentMethod,
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
        // customers-listing T4: the GET /customers item keeps its shape, so
        // `isTrusted` is read but not returned here (contract §6).
      }).toListResponse(),
      globalPriceList: c.globalPriceList ?? null,
      addresses: c.addresses,
      matchedPetName,
    };
  }

  private async buildFullResponse(
    customerId: string,
    options: { withPetCount?: boolean } = {},
  ) {
    const prisma = this.tenantPrisma.getClient();
    const data = await prisma.customer.findUnique({
      where: { id: customerId },
      include: {
        globalPriceList: { select: { id: true, name: true } },
        addresses: { orderBy: { createdAt: 'asc' } },
        ...(options.withPetCount
          ? { _count: { select: { pets: { where: { status: 'ACTIVE' } } } } }
          : {}),
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
      preferredPaymentMethod: data.preferredPaymentMethod,
      isTrusted: data.isTrusted,
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
      // customer-pets / T1: only the detail read (`GET /customers/:id`) adds it.
      ...(options.withPetCount
        ? { activePetsCount: data._count?.pets ?? 0 }
        : {}),
    };
  }
}
