/**
 * Event Listeners for Order domain events.
 *
 * This demonstrates how NestJS EventEmitter works as a
 * domain event bus. Other bounded contexts can react to
 * events without direct coupling.
 */
import { Injectable, Logger } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import {
  OrderPlacedEvent,
  OrderCompletedEvent,
  OrderCancelledEvent,
} from '../domain/events/order.events';
import { ProductsService } from 'src/products/products.service';

@Injectable()
export class OrderEventListener {
  private readonly logger = new Logger(OrderEventListener.name);
  constructor(private readonly productsService: ProductsService) {}

  @OnEvent('order.placed')
  handleOrderPlaced(event: OrderPlacedEvent) {
    this.logger.log(
      `Order ${event.orderId} placed by ${event.customerName}. ` +
        `${event.itemCount} items, total: ${event.totalAmount} ${event.totalCurrency}`,
    );
    // In production: send notification, update analytics, etc.
  }

  @OnEvent('order.completed')
  handleOrderCompleted(event: OrderCompletedEvent) {
    this.logger.log(
      `Order ${event.orderId} completed at ${event.completedAt.toISOString()}`,
    );
  }

  @OnEvent('order.cancelled')
  async handleOrderCancelled(event: OrderCancelledEvent) {
    this.logger.warn(
      `Order ${event.orderId} cancelled (was: ${event.previousStatus})`,
    );
    //restore stock, send notification, etc.

    for (const { productId, quantity } of event.productItems) {
      await this.productsService.increaseStock(productId, quantity);
    }
  }
}
