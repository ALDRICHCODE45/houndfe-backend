/**
 * PORT: IOrderRepository (Driven Port)
 */
import { Order } from './order.entity';
import type { OrderStatus } from './order.entity';

export interface IOrderRepository {
  findById(id: string): Promise<Order | null>;
  findByStatus(status: OrderStatus): Promise<Order[]>;
  findAll(): Promise<Order[]>;
  save(order: Order): Promise<Order>;
  delete(id: string): Promise<void>;
}

export const ORDER_REPOSITORY = Symbol('ORDER_REPOSITORY');
