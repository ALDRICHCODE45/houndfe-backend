/**
 * OrdersService - Application layer for orders.
 *
 * Coordinates between Order aggregate and Products bounded context.
 * Uses ProductsService (not ProductRepository directly) to respect
 * bounded context boundaries.
 */
import { Inject, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Order } from './domain/order.entity';
import { OrderItem } from './domain/order-item.value-object';
import type { IOrderRepository } from './domain/order.repository';
import { ORDER_REPOSITORY } from './domain/order.repository';
import {
  OrderPlacedEvent,
  OrderCompletedEvent,
  OrderCancelledEvent,
} from './domain/events/order.events';
import { PlaceOrderDto } from './dto/place-order.dto';
import { ProductsService } from '../products/products.service';
import { EntityNotFoundError } from '../shared/domain/domain-error';

@Injectable()
export class OrdersService {
  constructor(
    @Inject(ORDER_REPOSITORY)
    private readonly orderRepo: IOrderRepository,
    private readonly productsService: ProductsService,
    private readonly eventEmitter: EventEmitter2,
  ) {}

  /**
   * Places a new order.
   *
   * FLOW:
   * 1. Validate all products exist and have stock
   * 2. Create Order aggregate with items
   * 3. Place the order (state: DRAFT → PLACED)
   * 4. Decrease stock via ProductsService (cross-aggregate coordination)
   * 5. Persist and emit event
   */
  async placeOrder(dto: PlaceOrderDto) {
    // 1. Fetch products and build items
    const orderItems: OrderItem[] = [];
    const stockUpdates: { productId: string; quantity: number }[] = [];

    for (const itemDto of dto.items) {
      const productResponse = await this.productsService.findOne(
        itemDto.productId,
      );
      const { Money } =
        await import('../shared/domain/value-objects/money.value-object');
      const unitPrice = Money.fromDecimal(
        productResponse.price.amount,
        productResponse.price.currency,
      );

      const orderItem = OrderItem.create(
        productResponse.id,
        productResponse.name,
        itemDto.quantity,
        unitPrice,
      );
      orderItems.push(orderItem);
      stockUpdates.push({
        productId: productResponse.id,
        quantity: itemDto.quantity,
      });
    }

    // 2. Create order
    const order = Order.create(crypto.randomUUID(), dto.customerName);
    for (const item of orderItems) {
      order.addItem(item);
    }

    // 3. Place (DRAFT → PLACED)
    order.place();

    // 4. Decrease stock (cross-aggregate via service)
    for (const { productId, quantity } of stockUpdates) {
      await this.productsService.decreaseStock(productId, quantity);
    }

    // 5. Persist
    const saved = await this.orderRepo.save(order);

    // 6. Emit event
    this.eventEmitter.emit(
      'order.placed',
      new OrderPlacedEvent(
        saved.id,
        saved.customerName,
        saved.items.length,
        saved.total.amount,
        saved.total.currency,
      ),
    );

    return saved.toResponse();
  }

  async findAll() {
    const orders = await this.orderRepo.findAll();
    return orders.map((o) => o.toResponse());
  }

  async findOne(id: string) {
    const order = await this.orderRepo.findById(id);
    if (!order) throw new EntityNotFoundError('Order', id);
    return order.toResponse();
  }

  async cancel(id: string) {
    const order = await this.orderRepo.findById(id);
    if (!order) throw new EntityNotFoundError('Order', id);

    const previousStatus = order.status;
    order.cancel(); // domain validates state machine
    const saved = await this.orderRepo.save(order);

    const orderItemsForCancelledEvent = order.items.map((item) => {
      return {
        productId: item.productId,
        quantity: item.quantity,
      };
    });

    this.eventEmitter.emit(
      'order.cancelled',
      new OrderCancelledEvent(
        saved.id,
        previousStatus,
        orderItemsForCancelledEvent,
      ),
    );
    return saved.toResponse();
  }

  async complete(id: string) {
    const order = await this.orderRepo.findById(id);
    if (!order) throw new EntityNotFoundError('Order', id);

    order.complete();
    const saved = await this.orderRepo.save(order);

    this.eventEmitter.emit(
      'order.completed',
      new OrderCompletedEvent(saved.id, saved.completedAt!),
    );
    return saved.toResponse();
  }
}
