import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { Brand } from '../domain/brand.entity';
import type { IBrandRepository } from '../domain/brand.repository';
import type { Brand as PrismaBrand } from '@prisma/client';

@Injectable()
export class PrismaBrandRepository implements IBrandRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Brand | null> {
    const data = await this.prisma.brand.findUnique({ where: { id } });
    return data ? this.toDomain(data) : null;
  }

  async findByName(name: string): Promise<Brand | null> {
    const data = await this.prisma.brand.findUnique({ where: { name } });
    return data ? this.toDomain(data) : null;
  }

  async findAll(): Promise<Brand[]> {
    const data = await this.prisma.brand.findMany({
      orderBy: { name: 'asc' },
    });
    return data.map((d) => this.toDomain(d));
  }

  async save(brand: Brand): Promise<Brand> {
    const saved = await this.prisma.brand.upsert({
      where: { id: brand.id },
      update: {
        name: brand.name,
        updatedAt: new Date(),
      },
      create: {
        id: brand.id,
        name: brand.name,
      },
    });
    return this.toDomain(saved);
  }

  async delete(id: string): Promise<void> {
    await this.prisma.brand.delete({ where: { id } });
  }

  private toDomain(data: PrismaBrand): Brand {
    return Brand.fromPersistence({
      id: data.id,
      name: data.name,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    });
  }
}
