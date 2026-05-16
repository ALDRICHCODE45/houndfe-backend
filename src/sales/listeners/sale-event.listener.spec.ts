import { SaleEventListener } from './sale-event.listener';
import {
  SaleCustomerAssignedEvent,
  SaleCustomerClearedEvent,
  SaleShippingAddressClearedEvent,
  SaleShippingAddressSetEvent,
} from '../domain/events/sale.events';

describe('SaleEventListener', () => {
  it('logs customer and shipping events', () => {
    const listener = new SaleEventListener();
    const loggerSpy = jest
      .spyOn((listener as unknown as { logger: { log: (...args: unknown[]) => void } }).logger, 'log')
      .mockImplementation(() => undefined);

    listener.onSaleCustomerAssigned(
      new SaleCustomerAssignedEvent('sale-1', 'tenant-1', 'user-1', null, 'customer-1', null),
    );
    listener.onSaleCustomerCleared(
      new SaleCustomerClearedEvent('sale-1', 'tenant-1', 'user-1', 'customer-1', 'addr-1'),
    );
    listener.onSaleShippingAddressSet(
      new SaleShippingAddressSetEvent('sale-1', 'tenant-1', 'user-1', null, 'addr-1'),
    );
    listener.onSaleShippingAddressCleared(
      new SaleShippingAddressClearedEvent('sale-1', 'tenant-1', 'user-1', 'addr-1'),
    );

    expect(loggerSpy).toHaveBeenCalledTimes(4);
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'sale.customer.assigned', saleId: 'sale-1' }),
    );
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'sale.shipping-address.cleared', saleId: 'sale-1' }),
    );
  });

  it('logs seller assigned and cleared events', () => {
    const listener = new SaleEventListener();
    const loggerSpy = jest
      .spyOn((listener as unknown as { logger: { log: (...args: unknown[]) => void } }).logger, 'log')
      .mockImplementation(() => undefined);

    listener.onSaleSellerAssigned({
      saleId: 'sale-2',
      tenantId: 'tenant-1',
      userId: 'actor-1',
      previousSellerUserId: null,
      sellerUserId: 'seller-1',
    });
    listener.onSaleSellerCleared({
      saleId: 'sale-2',
      tenantId: 'tenant-1',
      userId: 'actor-1',
      previousSellerUserId: 'seller-1',
    });

    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'sale.seller.assigned', sellerUserId: 'seller-1' }),
    );
    expect(loggerSpy).toHaveBeenCalledWith(
      expect.objectContaining({ eventType: 'sale.seller.cleared', previousSellerUserId: 'seller-1' }),
    );
  });
});
