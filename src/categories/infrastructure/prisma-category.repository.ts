import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../shared/prisma/prisma.service';
import { Category } from '../domain/category.entity';
import type { ICategoryRepository } from '../domain/category.repository';
import type { Category as PrismaCategory } from '@prisma/client';

@Injectable()
export class PrismaCategoryRepository implements ICategoryRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findById(id: string): Promise<Category | null> {
    const data = await this.prisma.category.findUnique({ where: { id } });
    return data ? this.toDomain(data) : null;
  }

  async findByName(name: string): Promise<Category | null> {
    const data = await this.prisma.category.findUnique({ where: { name } });
    return data ? this.toDomain(data) : null;
  }

  async findAll(): Promise<Category[]> {
    const data = await this.prisma.category.findMany({
      orderBy: { name: 'asc' },
    });
    return data.map((d) => this.toDomain(d));
  }

  async save(category: Category): Promise<Category> {
    const saved = await this.prisma.category.upsert({
      where: { id: category.id },
      update: {
        name: category.name,
        updatedAt: new Date(),
      },
      create: {
        id: category.id,
        name: category.name,
      },
    });
    return this.toDomain(saved);
  }

  async delete(id: string): Promise<void> {
    await this.prisma.category.delete({ where: { id } });
  }

  private toDomain(data: PrismaCategory): Category {
    return Category.fromPersistence({
      id: data.id,
      name: data.name,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
    });
  }
}
