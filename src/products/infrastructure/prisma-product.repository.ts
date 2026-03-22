/**
 * ADAPTER: PrismaProductRepository
 *
 * Concrete implementation of IProductRepository using Prisma.
 *
 * Translates between domain entities and database records.
 * Contains mappers that convert DB rows ↔ domain objects.
 */
import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { Product } from '../domain/product.entity';
import type { IProductRepository } from '../domain/product.repository';
import type { Currency } from '../../shared/domain/value-objects/money.value-object';

@Injectable()
export class PrismaProductRepository implements IProductRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Product | null> {
    const data = await this.prisma.product.findUnique({ where: { id } });
    return data ? this.toDomain(data) : null;
  }

  async findBySku(sku: string): Promise<Product | null> {
    const data = await this.prisma.product.findUnique({
      where: { sku: sku.toUpperCase() },
    });
    return data ? this.toDomain(data) : null;
  }

  async findAll(): Promise<Product[]> {
    const data = await this.prisma.product.findMany({
      orderBy: { createdAt: 'desc' },
    });
    return data.map((d) => this.toDomain(d));
  }

  async findInStock(): Promise<Product[]> {
    const data = await this.prisma.product.findMany({
      where: { stock: { gt: 0 } },
      orderBy: { name: 'asc' },
    });
    return data.map((d) => this.toDomain(d));
  }

  async save(product: Product): Promise<Product> {
    const p = product.toPersistence();
    const saved = await this.prisma.product.upsert({
      where: { id: p.id },
      update: {
        name: p.name,
        price: p.price,
        currency: p.currency,
        stock: p.stock,
        updatedAt: new Date(),
      },
      create: {
        id: p.id,
        name: p.name,
        price: p.price,
        currency: p.currency,
        sku: p.sku,
        stock: p.stock,
      },
    });
    return this.toDomain(saved);
  }

  async delete(id: string): Promise<void> {
    await this.prisma.product.delete({ where: { id } });
  }

  private toDomain(data: {
    id: string;
    name: string;
    price: number;
    currency: string;
    sku: string;
    stock: number;
    createdAt: Date;
    updatedAt: Date;
  }): Product {
    return Product.fromPersistence({
      id: data.id,
      name: data.name,
      priceAmount: data.price / 100,
      priceCurrency: data.currency as Currency,
      sku: data.sku,
      stock: data.stock,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    });
  }
}
