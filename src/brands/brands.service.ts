import { Inject, Injectable } from '@nestjs/common';
import { Brand } from './domain/brand.entity';
import type { IBrandRepository } from './domain/brand.repository';
import { BRAND_REPOSITORY } from './domain/brand.repository';
import { CreateBrandDto } from './dto/create-brand.dto';
import { UpdateBrandDto } from './dto/update-brand.dto';
import {
  EntityNotFoundError,
  EntityAlreadyExistsError,
} from '../shared/domain/domain-error';

@Injectable()
export class BrandsService {
  constructor(
    @Inject(BRAND_REPOSITORY)
    private readonly brandRepo: IBrandRepository,
  ) {}

  async create(dto: CreateBrandDto) {
    const existing = await this.brandRepo.findByName(dto.name.trim());
    if (existing) {
      throw new EntityAlreadyExistsError('Brand', dto.name);
    }
    const brand = Brand.create(crypto.randomUUID(), dto.name);
    const saved = await this.brandRepo.save(brand);
    return saved.toResponse();
  }

  async findAll() {
    const brands = await this.brandRepo.findAll();
    return brands.map((b) => b.toResponse());
  }

  async findOne(id: string) {
    const brand = await this.brandRepo.findById(id);
    if (!brand) throw new EntityNotFoundError('Brand', id);
    return brand.toResponse();
  }

  async update(id: string, dto: UpdateBrandDto) {
    const brand = await this.brandRepo.findById(id);
    if (!brand) throw new EntityNotFoundError('Brand', id);

    if (dto.name !== undefined) {
      const existing = await this.brandRepo.findByName(dto.name.trim());
      if (existing && existing.id !== id) {
        throw new EntityAlreadyExistsError('Brand', dto.name);
      }
      brand.updateName(dto.name);
    }

    const saved = await this.brandRepo.save(brand);
    return saved.toResponse();
  }

  async remove(id: string): Promise<void> {
    const brand = await this.brandRepo.findById(id);
    if (!brand) throw new EntityNotFoundError('Brand', id);
    // Deleting sets products.brandId = null via Prisma onDelete: SetNull
    await this.brandRepo.delete(id);
  }
}
