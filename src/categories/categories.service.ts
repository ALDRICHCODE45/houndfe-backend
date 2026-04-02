import { Inject, Injectable } from '@nestjs/common';
import { Category } from './domain/category.entity';
import type { ICategoryRepository } from './domain/category.repository';
import { CATEGORY_REPOSITORY } from './domain/category.repository';
import { CreateCategoryDto } from './dto/create-category.dto';
import { UpdateCategoryDto } from './dto/update-category.dto';
import {
  EntityNotFoundError,
  EntityAlreadyExistsError,
} from '../shared/domain/domain-error';

@Injectable()
export class CategoriesService {
  constructor(
    @Inject(CATEGORY_REPOSITORY)
    private readonly categoryRepo: ICategoryRepository,
  ) {}

  async create(dto: CreateCategoryDto) {
    const existing = await this.categoryRepo.findByName(dto.name.trim());
    if (existing) {
      throw new EntityAlreadyExistsError('Category', dto.name);
    }

    const category = Category.create(crypto.randomUUID(), dto.name);
    const saved = await this.categoryRepo.save(category);
    return saved.toResponse();
  }

  async findAll() {
    const categories = await this.categoryRepo.findAll();
    return categories.map((c) => c.toResponse());
  }

  async findOne(id: string) {
    const category = await this.categoryRepo.findById(id);
    if (!category) throw new EntityNotFoundError('Category', id);
    return category.toResponse();
  }

  async update(id: string, dto: UpdateCategoryDto) {
    const category = await this.categoryRepo.findById(id);
    if (!category) throw new EntityNotFoundError('Category', id);

    if (dto.name !== undefined) {
      // Check uniqueness if name is changing
      const existing = await this.categoryRepo.findByName(dto.name.trim());
      if (existing && existing.id !== id) {
        throw new EntityAlreadyExistsError('Category', dto.name);
      }
      category.updateName(dto.name);
    }

    const saved = await this.categoryRepo.save(category);
    return saved.toResponse();
  }

  async remove(id: string): Promise<void> {
    const category = await this.categoryRepo.findById(id);
    if (!category) throw new EntityNotFoundError('Category', id);
    // Deleting sets products.categoryId = null via Prisma onDelete: SetNull
    await this.categoryRepo.delete(id);
  }
}
