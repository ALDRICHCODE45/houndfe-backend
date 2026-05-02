/**
 * ADAPTER: PrismaOrderRepository
 */
import { Injectable } from '@nestjs/common';
import { TenantPrismaService } from '../../shared/prisma/tenant-prisma.service';
import { Order, OrderStatus } from '../domain/order.entity';
import { OrderItem } from '../domain/order-item.value-object';
import type { Currency } from '../../shared/domain/value-objects/money.value-object';
import type { IOrderRepository } from '../domain/order.repository';

interface OrderItemPrisma {
  id: string;
  orderId: string;
  productId: string;
  productName: string;
  quantity: number;
  unitPriceCents: number;
  unitPriceCurrency: string;
}

@Injectable()
export class PrismaOrderRepository implements IOrderRepository {
  constructor(private readonly tenantPrisma: TenantPrismaService) {}

  async findById(id: string): Promise<Order | null> {
    const prisma = this.tenantPrisma.getClient();
    const data = await prisma.order.findUnique({
      where: { id },
      include: { items: true },
    });
    return data ? this.toDomain(data) : null;
  }

  async findByStatus(status: OrderStatus): Promise<Order[]> {
    const prisma = this.tenantPrisma.getClient();
    const data = await prisma.order.findMany({
      where: { status },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
    return data.map((d) => this.toDomain(d));
  }

  async findAll(): Promise<Order[]> {
    const prisma = this.tenantPrisma.getClient();
    const data = await prisma.order.findMany({
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
    return data.map((d) => this.toDomain(d));
  }

  async save(order: Order): Promise<Order> {
    const prisma = this.tenantPrisma.getClient();
    await prisma.order.upsert({
      where: { id: order.id },
      update: { status: order.status, completedAt: order.completedAt },
      create: {
        id: order.id,
        customerName: order.customerName,
        status: order.status,
        completedAt: order.completedAt,
      },
    });

    // Replace items (delete + recreate)
    await prisma.orderItem.deleteMany({ where: { orderId: order.id } });
    if (order.items.length > 0) {
      await prisma.orderItem.createMany({
        data: order.items.map((item) => ({
          id: crypto.randomUUID(),
          orderId: order.id,
          productId: item.productId,
          productName: item.productName,
          quantity: item.quantity,
          unitPriceCents: Math.round(item.unitPrice.amount * 100),
          unitPriceCurrency: item.unitPrice.currency,
        })),
      });
    }

    return (await this.findById(order.id))!;
  }

  async delete(id: string): Promise<void> {
    const prisma = this.tenantPrisma.getClient();
    await prisma.order.delete({ where: { id } });
  }

  private toDomain(data: {
    id: string;
    customerName: string;
    status: string;
    createdAt: Date;
    completedAt: Date | null;
    items: OrderItemPrisma[];
  }): Order {
    const items = data.items.map((item) =>
      OrderItem.fromPersistence({
        productId: item.productId,
        productName: item.productName,
        quantity: item.quantity,
        unitPriceAmount: item.unitPriceCents / 100,
        unitPriceCurrency: item.unitPriceCurrency as Currency,
      }),
    );
    return Order.fromPersistence({
      id: data.id,
      customerName: data.customerName,
      status: data.status,
      items,
      createdAt: data.createdAt,
      completedAt: data.completedAt,
    });
  }
}
