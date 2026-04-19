import { Brand } from './brand.entity';

export interface IBrandRepository {
  findById(id: string): Promise<Brand | null>;
  findByName(name: string): Promise<Brand | null>;
  findAll(): Promise<Brand[]>;
  save(brand: Brand): Promise<Brand>;
  delete(id: string): Promise<void>;
}

export const BRAND_REPOSITORY = Symbol('BRAND_REPOSITORY');
