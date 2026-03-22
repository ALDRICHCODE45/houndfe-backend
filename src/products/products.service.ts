/**
 * ProductsService - Application layer (Use Cases).
 *
 * Orchestrates domain logic and infrastructure.
 * This IS the "handler" / "use case" — but using NestJS conventions.
 *
 * RESPONSIBILITIES:
 * - Receive DTOs from controller
 * - Translate to domain operations
 * - Coordinate with repository
 * - Emit domain events
 * - Return results
 *
 * DOES NOT contain business logic (that's in Product entity).
 */
import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Product } from './domain/product.entity';
import type { IProductRepository } from './domain/product.repository';
import { PRODUCT_REPOSITORY } from './domain/product.repository';
import {
  ProductCreatedEvent,
  ProductStockDepletedEvent,
} from './domain/events/product.events';
import { CreateProductDto } from './dto/create-product.dto';
import { UpdateProductDto } from './dto/update-product.dto';
import { Money } from '../shared/domain/value-objects/money.value-object';
import {
  EntityNotFoundError,
  EntityAlreadyExistsError,
} from '../shared/domain/domain-error';
import { ProductName } from './domain/value-objects/productName.value-object';

@Injectable()
export class ProductsService {
  constructor(
    @Inject(PRODUCT_REPOSITORY)
    private readonly productRepo: IProductRepository,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  async create(dto: CreateProductDto) {
    const existing = await this.productRepo.findBySku(dto.sku);
    if (existing) throw new EntityAlreadyExistsError('Product', dto.sku);

    const price = Money.fromDecimal(dto.price, dto.currency);
    const name = ProductName.create(dto.name);

    const product = Product.create(
      crypto.randomUUID(),
      name,
      price,
      dto.sku,
      dto.stock ?? 0,
    );
    const saved = await this.productRepo.save(product);

    // Emit domain event
    this.eventEmitter.emit(
      'product.created',
      new ProductCreatedEvent(
        saved.id,
        saved.name.productName,
        saved.sku,
        saved.stock,
      ),
    );

    return saved.toResponse();
  }

  async findAll() {
    const products = await this.productRepo.findAll();
    return products.map((p) => p.toResponse());
  }

  async findOne(id: string) {
    const product = await this.productRepo.findById(id);
    if (!product) throw new EntityNotFoundError('Product', id);
    return product.toResponse();
  }

  async update(id: string, dto: UpdateProductDto) {
    const product = await this.productRepo.findById(id);
    if (!product) throw new EntityNotFoundError('Product', id);

    if (dto.price !== undefined && dto.currency) {
      product.updatePrice(Money.fromDecimal(dto.price, dto.currency));
    }

    if (dto.stock !== undefined) {
      const diff = dto.stock - product.stock;
      if (diff > 0) product.increaseStock(diff);
      else if (diff < 0) product.decreaseStock(Math.abs(diff));
    }

    if (dto.name !== undefined) {
      const newName = ProductName.create(dto.name);

      product.updateName(newName);
    }

    const saved = await this.productRepo.save(product);
    return saved.toResponse();
  }

  async remove(id: string): Promise<void> {
    const product = await this.productRepo.findById(id);
    if (!product) throw new EntityNotFoundError('Product', id);
    await this.productRepo.delete(id);
  }

  /**
   * Called by other modules (e.g., OrdersService) to decrease stock.
   * This keeps stock logic inside the Products bounded context.
   */
  async decreaseStock(productId: string, quantity: number): Promise<Product> {
    const product = await this.productRepo.findById(productId);
    if (!product) throw new EntityNotFoundError('Product', productId);

    product.decreaseStock(quantity); // domain validation happens here
    const saved = await this.productRepo.save(product);

    if (saved.isOutOfStock()) {
      this.eventEmitter.emit(
        'product.stock.depleted',
        new ProductStockDepletedEvent(saved.id, saved.name.productName),
      );
    }

    return saved;
  }

  async increaseStock(productId: string, quantity: number): Promise<Product> {
    const product = await this.productRepo.findById(productId);
    if (!product) throw new EntityNotFoundError('Product', productId);

    product.increaseStock(quantity); // domain validation happens here
    const saved = await this.productRepo.save(product);

    if (saved.isOutOfStock()) {
      this.eventEmitter.emit(
        'product.stock.depleted',
        new ProductStockDepletedEvent(saved.id, saved.name.productName),
      );
    }

    return saved;
  }
}
